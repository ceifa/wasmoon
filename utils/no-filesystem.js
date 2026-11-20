// Linked into the glue for `fs: 'none'`, which is built with FILESYSTEM=0. Emscripten's stand-ins
// for the file syscalls there report success without doing anything, so `io.open` would hand back
// a handle on fd 0 and `os.remove` would claim to have removed the file. These make every one of
// them fail with ENOSYS instead, and hand stdio to the same per byte callbacks FS.init takes in
// the other glues.
//
// Emscripten turns each function into source text, so nothing outside of them exists at run time:
// the errno values are written out in place (ENOSYS is 52, EBADF is 8).

addToLibrary({
    __syscall_openat: () => -52,
    __syscall_dup3: () => -52,
    __syscall_readlinkat: () => -52,
    __syscall_renameat: () => -52,
    __syscall_rmdir: () => -52,
    __syscall_unlinkat: () => -52,

    fd_write: (fd, iov, iovcnt, pnum) => {
        // LuaModule passes both callbacks, defaults included, so a missing one is a closed stream.
        const output = fd === 1 ? Module['stdout'] : fd === 2 ? Module['stderr'] : undefined
        if (!output) {
            return 8
        }
        let written = 0
        for (let i = 0; i < iovcnt; i++, iov += 8) {
            const pointer = HEAPU32[iov >> 2]
            const length = HEAPU32[(iov + 4) >> 2]
            for (let j = 0; j < length; j++) {
                output(HEAPU8[pointer + j])
            }
            written += length
        }
        HEAPU32[pnum >> 2] = written
        return 0
    },

    fd_read: (fd, iov, iovcnt, pnum) => {
        if (fd !== 0) {
            return 8
        }
        const input = Module['stdin']
        let read = 0
        // With no callback there is nothing to read at all, and an empty read is EOF.
        if (!input) {
            HEAPU32[pnum >> 2] = read
            return 0
        }
        // A null from the callback ends the read, as it does for a TTY.
        reading: for (let i = 0; i < iovcnt; i++, iov += 8) {
            const pointer = HEAPU32[iov >> 2]
            const length = HEAPU32[(iov + 4) >> 2]
            for (let j = 0; j < length; j++) {
                const byte = input()
                if (byte === null) {
                    break reading
                }
                HEAPU8[pointer + j] = byte
                read++
            }
        }
        HEAPU32[pnum >> 2] = read
        return 0
    },
})
