/**
 * kodak-photo-printer
 *
 * TypeScript library for Prinics-built instant photo printers, sold as Kodak
 * Mini Shot, Kodak Dock, PICKIT SNAPS and SI. Printing goes over Bluetooth
 * Classic SPP; USB is exposed for diagnostics. The protocol was recovered from
 * the official Android application; see PROTOCOL.md for the derivation and
 * CAPABILITIES.md for what is and is not supported.
 */

export {
  Printer,
  connectSerial,
  connectUsb,
  discover,
  type PrintOptions,
} from './printer.js';

export {
  SerialTransport,
  listSerialDevices,
  type SerialTransportOptions,
} from './transport/serial.js';

export {
  KodakError,
  MissingDependencyError,
  PrinterError,
  ProtocolError,
  TimeoutError,
  TransportError,
} from './errors.js';

export {
  ACCESSORY_MANUFACTURERS,
  ADB_INTERFACE,
  Ble,
  BleOpcode,
  Command,
  FirmwareState,
  DEFAULT_JOB_ID,
  FRAME_HEADER_SIZE,
  MODERN_PROTOCOL_LEVEL,
  Notification,
  PrintState,
  SESSION_PROTOCOL_REVISION,
  SPP_SERVICE_UUID,
  TransportKind,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
  type BleOpcodeValue,
  type CommandCode,
} from './protocol/constants.js';

export {
  FrameDecoder,
  decodeFrame,
  encodeFrame,
  readPayloadLength,
  readUint32BE,
  writeUint32BE,
  type Frame,
} from './protocol/frame.js';

/**
 * BLE framing codec. There is no BLE transport: these printers are reached over
 * Bluetooth Classic SPP. The codec is exported so captured GATT traffic can be
 * decoded. See PROTOCOL.md.
 */
export {
  BleSelector,
  bleCancelFrames,
  bleCommandSequence,
  bleDataFrames,
  decodeBleFrame,
  encodeBleCommand,
  encodeBleData,
  type BleSelectorValue,
  type DecodedBleFrame,
} from './protocol/ble.js';

export {
  PrintSession,
  type PrintProgress,
  type PrintSessionOptions,
  type SessionAction,
} from './protocol/session.js';

export {
  MediaType,
  faultMessage,
  isFault,
  parseMediaType,
  parseStatus,
  type PrinterStatus,
  type StatusKind,
} from './protocol/status.js';

export {
  DEVICE_INFO_COUNTERS,
  ModelBehaviour,
  deviceInfoRequest,
  parseDeviceInfo,
  parseSessionIdentity,
  type DeviceInfo,
  type SessionIdentity,
} from './protocol/device-info.js';

export {
  TypedEmitter,
  type DiscoveredDevice,
  type Transport,
  type TransportEvents,
  type TransportFraming,
} from './transport/types.js';

export { MockTransport, type MockTransportOptions } from './transport/mock.js';
export { UsbTransport, listUsbDevices, type UsbTransportOptions } from './transport/usb.js';

export {
  AdbHost,
  type AdbLink,
  type AdbStream,
  type AdbHostEvents,
} from './transport/adb/host.js';

export {
  ADB_HEADER_SIZE,
  ADB_LEGACY_MAX_PAYLOAD,
  ADB_MAX_PAYLOAD,
  ADB_VERSION,
  AdbAuth,
  AdbCommand,
  AdbMessageDecoder,
  DEFAULT_HOST_BANNER,
  checksum,
  commandName,
  connectMessage,
  decodeAdbHeader,
  encodeAdbHeader,
  encodeAdbMessage,
  isValidMagic,
  type AdbCommandValue,
  type AdbMessage,
} from './transport/adb/message.js';

export {
  MEDIA_PROFILES,
  findMediaProfile,
  isJpeg,
  prepareImage,
  readJpegSize,
  type FitMode,
  type MediaProfile,
  type PaperClass,
  type PrepareOptions,
  type PreparedImage,
} from './image/raster.js';
