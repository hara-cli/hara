// Private-pipe codec probe. NOT a Keychain helper: no Security API or storage.
#import "k1_codec.h"
#include <unistd.h>
#include <errno.h>
#include <sys/resource.h>
int main(int argc, const char *argv[]) {
    (void)argv;
    struct rlimit noCore = {0, 0};
    if (argc != 1 || setrlimit(RLIMIT_CORE, &noCore) != 0) return 64;
    @autoreleasepool {
        NSMutableData *frame = [NSMutableData dataWithLength:8500000];
        uint8_t *bytes = frame.mutableBytes; NSUInteger size = 0; int result = 64;
        for (;;) {
            uint8_t extra; ssize_t n = read(STDIN_FILENO, size < frame.length ? bytes + size : &extra,
                                           size < frame.length ? frame.length - size : 1);
            if (n < 0 && errno == EINTR) continue;
            if (n < 0 || (n > 0 && size == frame.length)) break;
            if (n == 0) {
                [frame setLength:size]; NSMutableData *out = K1RoundTrip(frame);
                if (!out) break;
                const uint8_t *p = out.bytes; NSUInteger left = out.length; result = 0;
                while (left) {
                    ssize_t written = write(STDOUT_FILENO, p, left);
                    if (written < 0 && errno == EINTR) continue;
                    if (written <= 0) { result = 74; break; }
                    p += written; left -= (NSUInteger)written;
                }
                memset(out.mutableBytes, 0, out.length); break;
            }
            size += (NSUInteger)n;
            if (size >= 4) {
                uint32_t declared = bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
                if (declared > 8499996 || size > (NSUInteger)declared + 4) break;
            }
        }
        memset(frame.mutableBytes, 0, frame.length);
        return result; // Fixed exit status only. No secret-bearing stderr.
    }
}
