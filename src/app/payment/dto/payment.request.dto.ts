import {Type} from "class-transformer";
import {IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength} from "class-validator";

export class InitPaymentRequestDTO {
    @IsUUID()
    orderId!: string;                   // order publicId
}

export class RefundRequestDTO {
    @IsOptional()
    @Type(() => Number)
    @IsInt() @Min(1)
    amount?: number;                    // minor units; omitted -> the full refundable amount

    @IsString() @MinLength(1) @MaxLength(500)
    reason!: string;
}
