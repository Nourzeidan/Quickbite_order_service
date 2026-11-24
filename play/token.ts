// Signs a test access token with the shared ACCESS_SECRET (the same way core-service does).
//   npx tsx play/token.ts customer                       -> {userId: 1, role: customer}
//   npx tsx play/token.ts restaurant_user                -> owner of restaurant 5, branch 10
//   npx tsx play/token.ts role=restaurant_user userId=900 restaurantId=1 restaurantRole=staff branchIds=1
//   npx tsx play/token.ts role=admin userId=999
// key=value args override the preset; branchIds is a comma list ("1,2"), number-looking values become numbers.
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env.js";

const args = process.argv.slice(2);
const preset = args[0] && !args[0].includes("=") ? args.shift()! : "customer";

const payload: Record<string, unknown> = preset === "restaurant_user"
    ? {userId: 2, email: "r@test.com", role: preset, restaurantId: 5, restaurantRole: "owner", branchIds: [10]}
    : {userId: 1, email: "c@test.com", role: preset};

for(const arg of args){
    const eq = arg.indexOf("=");
    if(eq < 0) continue;
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if(key === "branchIds"){
        payload[key] = value === "" ? [] : value.split(",").map(Number);
    }else{
        payload[key] = /^\d+$/.test(value) ? Number(value) : value;
    }
}
if(payload.role !== "restaurant_user"){
    delete payload.restaurantId;
    delete payload.restaurantRole;
    delete payload.branchIds;
}

console.log(jwt.sign(payload, env.jwt.accessSecret, {expiresIn: "1h"}));
