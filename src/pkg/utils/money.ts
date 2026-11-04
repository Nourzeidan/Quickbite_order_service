// All money in this service is INT minor units (piasters, halalas).
// Core sends prices as DECIMAL strings ("55.00") -> convert with string math, never float math.

const MONEY_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

export function toMinor(amount: string | number, fractionDigits: number = 2): number {
    const text = typeof amount === "number" ? amount.toFixed(fractionDigits) : amount.trim();
    const match = MONEY_PATTERN.exec(text);
    if(!match){
        throw new Error(`Invalid money amount: "${amount}"`);
    }

    const negative = match[1] === "-";
    const whole = match[2]!;
    const fraction = match[3] ?? "";

    // "55.001" would silently lose money -> reject; "55.000" is fine
    if(fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits))){
        throw new Error(`Money amount has more than ${fractionDigits} decimal places: "${amount}"`);
    }

    const minor = Number(whole) * 10 ** fractionDigits + Number(fraction.padEnd(fractionDigits, "0").slice(0, fractionDigits));
    if(!Number.isSafeInteger(minor)){
        throw new Error(`Money amount out of range: "${amount}"`);
    }
    return negative ? -minor : minor;
}

export function fromMinor(minor: number, fractionDigits: number = 2): string {
    const negative = minor < 0;
    const digits = String(Math.abs(minor)).padStart(fractionDigits + 1, "0");
    const whole = digits.slice(0, digits.length - fractionDigits);
    const fraction = digits.slice(digits.length - fractionDigits);
    return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function sumMinor(values: number[]): number {
    let total = 0;
    for(const value of values){
        total += value;
    }
    return total;
}

export function multiplyMinor(unitPriceMinor: number, quantity: number): number {
    return unitPriceMinor * quantity;
}

// basis points: 1500 bps = 15%. Rounds down so the platform never over-charges.
export function applyBps(amountMinor: number, bps: number): number {
    return Math.floor((amountMinor * bps) / 10000);
}
