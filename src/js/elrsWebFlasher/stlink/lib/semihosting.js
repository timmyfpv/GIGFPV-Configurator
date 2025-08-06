/* semihosting.js
 * ARM Semihosting debug I/O operations
 *
 * Copyright Devan Lai 2017
 *
 */

const opcodes = {
    SYS_OPEN: 0x01,
    SYS_CLOSE: 0x02,
    SYS_WRITEC: 0x03,
    SYS_WRITE0: 0x04,
    SYS_WRITE: 0x05,
    SYS_READ: 0x06,
    SYS_READC: 0x07,
    SYS_ISERROR: 0x08,
    SYS_ISTTY: 0x09,
    SYS_SEEK: 0x0a,
    SYS_FLEN: 0x0c,
    SYS_TMPNAM: 0x0d,
    SYS_REMOVE: 0x0e,
    SYS_RENAME: 0x0f,
    SYS_CLOCK: 0x10,
    SYS_TIME: 0x11,
    SYS_SYSTEM: 0x12,
    SYS_ERRNO: 0x13,
    SYS_GET_CMDLINE: 0x15,
    SYS_HEAPINFO: 0x016,
    SYS_ELAPSED: 0x030,
    SYS_TICKFREQ: 0x31,
};

export { opcodes };
