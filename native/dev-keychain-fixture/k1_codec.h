// K1 slice 1 only. No credential storage or production helper entry point.
#ifndef K1_FAKE_ONLY
#error "The K1 codec fixture requires K1_FAKE_ONLY"
#endif
#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
// Fully decode and canonically re-encode one bounded request or reply.
// Replies are checked against the nonce in their header; callers must separately
// bind the returned frame to their request nonce (the JS codec tests do this).
FOUNDATION_EXPORT NSMutableData * _Nullable K1RoundTrip(NSData *frame);
NS_ASSUME_NONNULL_END
