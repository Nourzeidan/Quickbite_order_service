// Sends a Kashier-shaped webhook, signed with KASHIER_WEBHOOK_SECRET, to the local server.
// Lets you test every webhook branch without paying in the Kashier sandbox.
//
//   npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<minor> [event=pay] [status=SUCCESS] [tx=TX-1] [kashierOrderId=K-1] [currency=EGP]
//   npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=12000 status=FAILURE tx=TX-2
//   npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=5000 event=refund tx=RF-1 kashierOrderId=K-1
//   npx tsx play/kashier-webhook.ts ... badsig=1          -> wrong signature (expect 401)
//
// `amount` is always given in MINOR units here; it is sent in the unit KASHIER_WEBHOOK_AMOUNT_UNIT says.
import {env} from "../src/lib/config/env.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const eq = arg.indexOf("=");
    return eq < 0 ? [arg, "1"] : [arg.slice(0, eq), arg.slice(eq + 1)];
}));

if(!args.ref || !args.amount){
    console.error("usage: npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<minor> [event=pay] [status=SUCCESS] [tx=..] [kashierOrderId=..]");
    process.exit(1);
}

const amountMinor = Number(args.amount);
const data: Record<string, unknown> = {
    merchantOrderId: args.ref,
    kashierOrderId: args.kashierOrderId ?? `K-${args.ref}`,
    orderReference: `TEST-ORD-${Date.now()}`,
    transactionId: args.tx ?? `TX-${Date.now()}`,
    status: args.status ?? "SUCCESS",
    method: "card",
    creationDate: new Date().toISOString(),
    amount: env.kashier.webhookAmountUnit === "minor" ? amountMinor : Number(fromMinor(amountMinor)),
    currency: args.currency ?? "EGP",
    transactionResponseCode: (args.status ?? "SUCCESS") === "SUCCESS" ? "00" : "05",
    channel: "online | e-commerce",
};
data.signatureKeys = [
    "amount", "channel", "currency", "kashierOrderId", "merchantOrderId", "method",
    "orderReference", "status", "transactionId", "transactionResponseCode",
];

const signature = args.badsig
    ? "0".repeat(64)
    : signKashierPayload(buildSignaturePayload(data, data.signatureKeys as string[]), env.kashier.webhookSecret);

const body = {event: args.event ?? "pay", data};
const url = args.url ?? `http://localhost:${env.port}/api/payments/webhook/kashier`;

const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json", "x-kashier-signature": signature},
    body: JSON.stringify(body),
});
console.log(response.status, await response.text());
