import crypto from "crypto";

// Kashier webhook signature (https://developers.kashier.io/webhooks/setup):
//   keys = data.signatureKeys sorted; payload = "k1=v1&k2=v2" with values URL-encoded the way the
//   `query-string` package does it (strict: encodeURIComponent + !'()*); HMAC-SHA256(key) hex.

function strictEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildSignaturePayload(data: Record<string, unknown>, signatureKeys: string[]): string {
    const parts: string[] = [];
    for(const key of [...signatureKeys].sort()){
        const value = data[key];
        if(value === undefined){
            continue;                                   // query-string skips undefined
        }
        if(value === null){
            parts.push(strictEncode(key));              // ... and writes a bare key for null
            continue;
        }
        const text = typeof value === "object" ? JSON.stringify(value) : String(value);
        parts.push(`${strictEncode(key)}=${strictEncode(text)}`);
    }
    return parts.join("&");
}

export function signKashierPayload(payload: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// constant-time compare; false for anything malformed
export function verifyKashierSignature(data: Record<string, unknown>, signatureKeys: string[], signature: string, secret: string): boolean {
    const expected = Buffer.from(signKashierPayload(buildSignaturePayload(data, signatureKeys), secret), "hex");
    const received = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
    if(received.length !== expected.length){
        return false;
    }
    return crypto.timingSafeEqual(received, expected);
}
