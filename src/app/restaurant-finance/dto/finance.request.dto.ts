import {Type} from "class-transformer";
import {IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength} from "class-validator";
import {Currency} from "../../order/enums.js";

// GET /restaurant/balance — restaurantId is read only for admins (restaurant users: from the JWT)
export class RestaurantBalanceQueryDTO {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    restaurantId?: number;
}

// GET /restaurant/payouts?from=&to= (default: last 90 days)
export class RestaurantPayoutsQueryDTO {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    restaurantId?: number;

    @IsOptional() @IsISO8601()
    from?: string;

    @IsOptional() @IsISO8601()
    to?: string;

    @IsOptional() @IsString()
    cursor?: string;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
    limit?: number;
}

// POST /restaurant/payouts (admin) — records a transfer operations already made. amount in minor units
export class CreatePayoutRequestDTO {
    @IsInt() @Min(1)
    restaurantId!: number;

    @IsInt() @Min(1)
    amount!: number;

    @IsIn(Object.values(Currency))
    currency!: Currency;

    @IsString() @MinLength(1) @MaxLength(200)
    providerReferenceId!: string;

    @IsOptional() @IsString() @MaxLength(500)
    note?: string;
}
