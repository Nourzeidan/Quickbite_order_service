import {Type} from "class-transformer";
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsEnum,
    IsIn,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateNested
} from "class-validator";
import {OrderStatus, PATCHABLE_STATUSES, PaymentMethod, type PatchableStatus} from "../enums.js";

export class OrderItemInputDTO {
    @IsInt() @Min(1)
    productId!: number;

    @IsInt() @Min(1) @Max(50)
    quantity!: number;
}

export class CreateOrderRequestDTO {
    @IsInt() @Min(1)
    branchId!: number;

    @IsInt() @Min(1)
    customerAddressId!: number;

    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    @IsArray()
    @ArrayMinSize(1) @ArrayMaxSize(50)
    @ValidateNested({each: true})
    @Type(() => OrderItemInputDTO)
    items!: OrderItemInputDTO[];
}

export class UpdateOrderStatusRequestDTO {
    @IsIn(PATCHABLE_STATUSES)
    status!: PatchableStatus;

    @IsOptional() @IsString() @MaxLength(500)
    reason?: string;
}

// query values arrive as strings. @Type converts them explicitly: enableImplicitConversion alone
// relies on emitDecoratorMetadata, which tsx (esbuild, used by `npm run dev`) does not emit.
class CursorQueryDTO {
    @IsOptional() @IsString() @MaxLength(512)
    cursor?: string;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
    limit?: number;
}

export class CustomerOrdersQueryDTO extends CursorQueryDTO {
    @IsOptional() @Type(() => Number) @IsInt() @Min(2020) @Max(9999)
    year?: number;
}

export class RestaurantOrdersQueryDTO extends CursorQueryDTO {
    @Type(() => Number) @IsInt() @Min(1)
    branchId!: number;

    @IsOptional() @IsEnum(OrderStatus)
    status?: OrderStatus;

    @IsOptional() @IsISO8601()
    from?: string;

    @IsOptional() @IsISO8601()
    to?: string;
}

export class AdminOrdersQueryDTO extends CursorQueryDTO {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    branchId?: number;

    @IsOptional() @IsEnum(OrderStatus)
    status?: OrderStatus;

    @IsOptional() @IsISO8601()
    from?: string;

    @IsOptional() @IsISO8601()
    to?: string;
}
