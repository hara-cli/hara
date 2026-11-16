#import "k1_codec.h"
#include <string.h>
// A deliberate package-guard canary, never a production helper.
__attribute__((used)) static const char kFixtureMarker[] =
    "HARA_DEV_CREDENTIAL_VAULT_ONLY_V1:tech.nanhara.hara.workspace.credentials.dev.v1";
static const NSUInteger kMaxRequest = 8500000, kMaxReply = 65600, kMaxUnits = 16384;
static uint16_t U16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static uint32_t U32(const uint8_t *p) { return U16(p) | ((uint32_t)U16(p + 2) << 16); }
static void Put16(NSMutableData *d, uint16_t v) { uint8_t b[] = {v & 255, v >> 8}; [d appendBytes:b length:2]; }
static void Put32(NSMutableData *d, uint32_t v) { Put16(d, v & 65535); Put16(d, v >> 16); }
static BOOL Take(NSData *d, NSUInteger *at, NSUInteger n, const uint8_t **bytes) {
    if (*at > d.length || n > d.length - *at) return NO;
    *bytes = (const uint8_t *)d.bytes + *at; *at += n; return YES;
}
static BOOL RefByte(uint8_t c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '_' || c == '.' || c == ':' || c == '-';
}
static BOOL Forbidden(uint16_t c) {
    return c <= 0x20 || c == 0x7f || c == 0xa0 || c == 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 ||
        c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
static BOOL KeyBytes(const uint8_t *b, uint32_t units) {
    if (!units || units > kMaxUnits) return NO;
    for (uint32_t i = 0; i < units; i++) {
        uint16_t c = U16(b + i * 2);
        if (Forbidden(c)) return NO;
        if (c >= 0xd800 && c <= 0xdbff) {
            if (++i >= units) return NO;
            uint16_t low = U16(b + i * 2);
            if (low < 0xdc00 || low > 0xdfff) return NO;
        } else if (c >= 0xdc00 && c <= 0xdfff) return NO;
    }
    return YES;
}
static NSMutableData *Request(NSData *d) {
    const uint8_t *b = d.bytes;
    if (d.length < 28 || d.length > kMaxRequest || b[8] < 1 || b[8] > 3 || b[9] > 1) return nil;
    uint16_t count = U16(b + 26);
    if (!count || count > 256 || (b[8] != 2 && count != 1)) return nil;
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray arrayWithCapacity:count];
    NSMutableSet<NSString *> *refs = [NSMutableSet set]; NSString *scope = nil;
    NSUInteger at = 28; const uint8_t *p;
    for (uint16_t i = 0; i < count; i++) {
        if (!Take(d, &at, 2, &p)) return nil;
        uint16_t len = U16(p);
        if (!len || len > 240 || !Take(d, &at, len, &p)) return nil;
        for (uint16_t j = 0; j < len; j++) if (!RefByte(p[j])) return nil;
        NSString *ref = [[NSString alloc] initWithBytes:p length:len encoding:NSASCIIStringEncoding];
        NSString *prefix = [ref componentsSeparatedByString:@":"].firstObject;
        if ([refs containsObject:ref] || (scope && ![scope isEqualToString:prefix])) return nil;
        scope = prefix; [refs addObject:ref];
        if (!Take(d, &at, 4, &p)) return nil;
        uint32_t units = U32(p);
        if (units > kMaxUnits || !Take(d, &at, (NSUInteger)units * 2, &p)) return nil;
        if (b[8] == 2 ? !KeyBytes(p, units) : units != 0) return nil;
        [entries addObject:@{@"ref":ref, @"key":[NSData dataWithBytes:p length:(NSUInteger)units * 2]}];
    }
    if (at != d.length) return nil;
    NSMutableData *out = [NSMutableData data];
    Put32(out, (uint32_t)d.length - 4); [out appendBytes:"HDQ1" length:4];
    [out appendBytes:b + 8 length:18]; Put16(out, count);
    for (NSDictionary *entry in entries) {
        NSData *ref = [entry[@"ref"] dataUsingEncoding:NSASCIIStringEncoding], *key = entry[@"key"];
        Put16(out, (uint16_t)ref.length); [out appendData:ref];
        Put32(out, (uint32_t)key.length / 2); [out appendData:key];
    }
    return out;
}
static NSMutableData *Reply(NSData *d) {
    if (d.length < 30 || d.length > kMaxReply) return nil;
    const uint8_t *b = d.bytes; uint32_t units = U32(b + 26);
    if (b[24] > 6 || b[25] > 1 || units > kMaxUnits || d.length != 30 + (NSUInteger)units * 2 ||
        (b[25] ? b[24] != 0 || !KeyBytes(b + 30, units) : units != 0)) return nil;
    NSMutableData *out = [NSMutableData data];
    Put32(out, (uint32_t)d.length - 4); [out appendBytes:"HDR1" length:4];
    [out appendBytes:b + 8 length:18]; Put32(out, units);
    // Native output is canonical UTF-16LE bytes, with pairing validated above.
    [out appendBytes:b + 30 length:(NSUInteger)units * 2]; return out;
}
NSMutableData *K1RoundTrip(NSData *d) {
    if (d.length < 8 || d.length > kMaxRequest || U32(d.bytes) != d.length - 4) return nil;
    const uint8_t *b = d.bytes;
    if (memcmp(b + 4, "HDQ1", 4) == 0) return Request(d);
    if (memcmp(b + 4, "HDR1", 4) == 0) return Reply(d);
    return nil;
}
