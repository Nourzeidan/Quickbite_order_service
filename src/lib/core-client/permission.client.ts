import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {CoreClient} from "./core-client.js";

@injectable()
export class PermissionClient {
    constructor(@inject(TOKENS.CoreClient) private readonly coreClient: CoreClient){}

    // ["order:order:read", ...] (core's `${resource}:${action}` format)
    getRolePermissions = async (roleName: string, correlationId?: string): Promise<string[]> => {
        return this.coreClient.request<string[]>({
            method: "GET",
            path: `/api/internal/roles/${encodeURIComponent(roleName)}/permissions`,
            ...(correlationId ? {correlationId} : {}),
        });
    }
}
