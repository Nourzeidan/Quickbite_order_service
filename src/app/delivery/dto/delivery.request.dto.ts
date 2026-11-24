import {Type} from "class-transformer";
import {IsEnum, IsIn, IsInt, IsISO8601, IsLatitude, IsLongitude, IsOptional, IsString, Max, MaxLength, Min} from "class-validator";
import {OrderStatus} from "../../order/enums.js";
import {DeliveryAction} from "../enums.js";

export class PresenceRequestDTO {
    @Type(() => Number) @IsLatitude()
    lat!: number;

    @Type(() => Number) @IsLongitude()
    lng!: number;
}

export class UpdateDeliveryStatusRequestDTO {
    @IsEnum(DeliveryAction)
    status!: DeliveryAction;

    @IsOptional() @IsString() @MaxLength(500)
    reason?: string;
}

export class AgentTasksQueryDTO {
    @IsOptional() @IsIn([OrderStatus.ASSIGNED, OrderStatus.PICKED, OrderStatus.DELIVERED, OrderStatus.CANCELLED])
    status?: OrderStatus;

    @IsOptional() @IsString()
    cursor?: string;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
    limit?: number;
}

export class AgentEarningsQueryDTO {
    @IsOptional() @IsISO8601()
    from?: string;

    @IsOptional() @IsISO8601()
    to?: string;

    @IsOptional() @IsString()
    cursor?: string;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
    limit?: number;
}
