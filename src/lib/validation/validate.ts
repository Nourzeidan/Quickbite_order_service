import {validate, type ValidationError} from "class-validator";
import {plainToInstance} from "class-transformer";
import {AppError} from "../error/AppError.js";

function collectMessages(errors: ValidationError[]): string[] {
    return errors.flatMap((error) => [
        ...Object.values(error.constraints ?? {}),
        ...collectMessages(error.children ?? [])
    ]);
}

async function validateInto<T extends object>(cls: new () => T, payload: unknown, implicitConversion: boolean): Promise<T> {
    const instance = plainToInstance(cls, payload, {enableImplicitConversion: implicitConversion});
    const errors = await validate(instance, {whitelist: true, forbidNonWhitelisted: true});

    if(errors.length > 0){
        throw new AppError(`Validation failed: ${collectMessages(errors).join(", ")}`, 400);
    }
    return instance;
}

export async function validateBody<T extends object>(cls: new () => T, body: unknown): Promise<T> {
    return validateInto(cls, body, false);
}

// query strings are all strings -> let class-transformer convert "20" to 20 for @IsInt() fields
export async function validateQuery<T extends object>(cls: new () => T, query: unknown): Promise<T> {
    return validateInto(cls, query, true);
}
