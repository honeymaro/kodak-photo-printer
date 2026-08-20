"""Enumerate which ADB service names the printer's adbd accepts.

The printer does not open a stream on its own when a PC is the host, so the
host has to name a service. This tries a broad candidate list and reports
which ones adbd accepts.

Only opens and immediately closes each stream. It never sends print protocol
bytes, so it cannot start a print.

Run with the adb server available (this talks to it, not to libusb):
    python tools/enumerate-adb-services.py
"""

import socket
import sys

ADB_SERVER = ("127.0.0.1", 5037)
SERIAL = None  # filled in from `host:devices`

# State-changing services are deliberately excluded: tcpip:, usb:, reboot:,
# root:, unroot:, remount: all reconfigure the device.
STANDARD = [
    "shell:", "shell,raw:", "shell,v2:", "exec:id", "sync:",
    "framebuffer:", "jdwp", "track-jdwp", "log:main", "sink:", "source:",
    "dev:/dev/null", "localfilesystem:/dev/socket/adbd",
    "reverse:list-forward", "backup:noapk", "restore:",
]

# Names a printing service might plausibly use.
VENDOR = [
    "print:", "printer:", "printing:", "prinics:", "ppvp:", "kodak:",
    "photo:", "photoprinter:", "image:", "img:", "picture:",
    "job:", "spool:", "spooler:", "queue:",
    "p2p:", "pp:", "ps:", "pd:",
    "service:", "app:", "launch:", "start:",
    "factory:", "mfg:", "test:", "diag:", "debug:",
    "usbprint:", "accessory:", "aoa:",
]

# Abstract unix sockets an on-device app might listen on.
ABSTRACT = [
    "printer", "print", "printservice", "prinics", "ppvp", "kodak",
    "photoprinter", "spooler", "jobqueue", "aoa", "accessory",
    "adbd", "jdwp-control", "bootanim", "property_service",
]

# Loopback ports on the device.
TCP_PORTS = [56065, 12231, 12232, 9100, 8080, 8000, 5555, 6666, 7777]


def detect_serial():
    """Asks the adb server which device is attached."""
    s = socket.create_connection(ADB_SERVER, timeout=3)
    try:
        msg = "host:devices"
        s.sendall(b"%04x%s" % (len(msg), msg.encode()))
        if s.recv(4) != b"OKAY":
            return None
        hexlen = s.recv(4)
        body = s.recv(int(hexlen, 16)).decode()
        for line in body.splitlines():
            if line.strip():
                return line.split("\t")[0]
        return None
    finally:
        s.close()


def try_service(service, timeout=2.5):
    """Opens one service. Returns (accepted, detail)."""
    try:
        s = socket.create_connection(ADB_SERVER, timeout=timeout)
    except Exception as exc:
        return False, "no adb server: %s" % exc
    s.settimeout(timeout)
    try:
        msg = "host:transport:%s" % SERIAL
        s.sendall(b"%04x%s" % (len(msg), msg.encode()))
        if s.recv(4) != b"OKAY":
            return False, "device gone"

        s.sendall(b"%04x%s" % (len(service), service.encode()))
        status = s.recv(4)
        if status != b"OKAY":
            hexlen = s.recv(4)
            reason = b""
            if len(hexlen) == 4:
                try:
                    reason = s.recv(int(hexlen, 16))
                except Exception:
                    pass
            return False, reason.decode("utf-8", "replace") or "refused"

        # Accepted. Peek at anything it volunteers, then close immediately.
        try:
            data = s.recv(128)
        except socket.timeout:
            data = b""
        return True, repr(data[:100]) if data else "(silent)"
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)
    finally:
        try:
            s.close()
        except Exception:
            pass


def sweep(title, names, formatter=lambda n: n):
    print("\n== %s ==" % title)
    accepted = []
    for name in names:
        service = formatter(name)
        ok, detail = try_service(service)
        if ok:
            accepted.append(service)
            print("  ACCEPTED  %-34s %s" % (service, detail))
        elif "device gone" in detail:
            print("  device disappeared while probing %s" % service)
            return accepted
    if not accepted:
        print("  none accepted")
    return accepted


def main():
    global SERIAL
    SERIAL = detect_serial()
    if SERIAL is None:
        print("No device attached. Is the printer powered on?")
        return 1
    print("device: %s" % SERIAL)
    print("(refused services are omitted; only accepted ones are listed)")

    found = []
    found += sweep("standard adb services", STANDARD)
    found += sweep("vendor name guesses", VENDOR)
    found += sweep("abstract sockets", ABSTRACT, lambda n: "localabstract:%s" % n)
    found += sweep("device loopback ports", TCP_PORTS, lambda p: "tcp:%d" % p)

    print("\n== summary ==")
    if found:
        for service in found:
            print("  %s" % service)
    else:
        print("  nothing accepted")
    print("\nNo print commands were sent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
