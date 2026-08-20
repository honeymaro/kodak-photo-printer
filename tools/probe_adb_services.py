"""Non-destructive probe of the printer's adbd.

Only opens read-only / connect-only services. Deliberately avoids
tcpip:, root:, remount:, reboot: and anything else that changes device state.

The device serial is taken from the adb server, so no identifier is baked in.
Pass one as the first argument to target a specific device when several are
attached:

    python tools/probe_adb_services.py [serial]
"""
import socket
import sys
from concurrent.futures import ThreadPoolExecutor

ADB_SERVER = ("127.0.0.1", 5037)

# Filled in by detect_serial(), or from argv.
SERIAL = None


def detect_serial():
    """Asks the adb server which device is attached."""
    try:
        s = socket.create_connection(ADB_SERVER, timeout=3)
    except Exception:
        return None
    try:
        msg = "host:devices"
        s.sendall(b"%04x%s" % (len(msg), msg.encode()))
        if s.recv(4) != b"OKAY":
            return None
        hexlen = s.recv(4)
        if len(hexlen) < 4:
            return None
        body = s.recv(int(hexlen, 16)).decode("utf-8", "replace")
        for line in body.splitlines():
            if line.strip():
                return line.split("\t")[0]
        return None
    finally:
        try:
            s.close()
        except Exception:
            pass


def adb_open(service, timeout=2.0, read_first=True, read_size=200):
    """Open one adb service on the device. Returns (ok, info)."""
    try:
        s = socket.create_connection(ADB_SERVER, timeout=timeout)
    except Exception as exc:
        return False, "no-adb-server: %s" % exc
    s.settimeout(timeout)
    try:
        msg = "host:transport:%s" % SERIAL
        s.sendall(b"%04x%s" % (len(msg), msg.encode()))
        if s.recv(4) != b"OKAY":
            return False, "transport-gone"

        s.sendall(b"%04x%s" % (len(service), service.encode()))
        st = s.recv(4)
        if st != b"OKAY":
            hexlen = s.recv(4)
            reason = b""
            if len(hexlen) == 4:
                reason = s.recv(int(hexlen, 16))
            return False, reason.decode("utf-8", "replace") or "FAIL"

        if not read_first:
            return True, "<open>"
        try:
            data = s.recv(read_size)
        except socket.timeout:
            data = b""
        return True, repr(data[:read_size]) if data else "<open, silent>"
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)
    finally:
        try:
            s.close()
        except Exception:
            pass


def scan_tcp(port):
    ok, info = adb_open("tcp:%d" % port, timeout=2.0, read_first=False)
    return port, ok, info


def main():
    global SERIAL
    SERIAL = sys.argv[1] if len(sys.argv) > 1 else detect_serial()
    if SERIAL is None:
        print("No device attached. Is the printer powered on?")
        return 1
    print("device: %s\n" % SERIAL)

    print("== 1. jdwp / process enumeration ==")
    for svc in ("track-jdwp", "jdwp"):
        ok, info = adb_open(svc, timeout=4.0)
        print("  %-14s %s %s" % (svc, "OK  " if ok else "FAIL", info))

    print("\n== 2. read-only info services ==")
    for svc in ("host:features", "reverse:list-forward", "sync:",
                "shell:", "exec:echo hi", "framebuffer:", "restore:",
                "backup:all"):
        ok, info = adb_open(svc, timeout=2.0)
        print("  %-22s %s %s" % (svc, "OK  " if ok else "FAIL", info))

    print("\n== 3. localabstract sockets ==")
    names = ["printer", "print", "prinics", "ppvp", "kodak", "adbd",
             "jdwp-control", "property_service", "zygote", "installd"]
    for n in names:
        ok, info = adb_open("localabstract:%s" % n, timeout=2.0,
                            read_first=False)
        print("  %-24s %s %s" % (n, "OK  " if ok else "FAIL", info))

    print("\n== 4. tcp: port scan (device localhost) ==")
    ports = [80, 631, 3000, 5037, 5555, 8000, 8080, 8081, 8888, 9100,
             9101, 12231, 12232, 15000, 50000, 55000, 56065, 56066]
    ports += list(range(1024, 1120))
    ports += list(range(8000, 8100))
    ports += list(range(9000, 9200))
    ports += list(range(56000, 56100))
    ports = sorted(set(ports))
    print("  scanning %d ports ..." % len(ports))
    open_ports = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        for port, ok, info in ex.map(scan_tcp, ports):
            if ok:
                open_ports.append(port)
                print("  OPEN tcp:%d" % port)
            elif "transport-gone" in info:
                print("  device disappeared at port %d" % port)
                break
    if not open_ports:
        print("  no listening ports found in scanned range")
    else:
        print("  open: %s" % open_ports)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
