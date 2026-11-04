export class OrderItem {
    id: number;
    region: string;
    orderId: number;
    productId: number;
    quantity: number;
    unitPrice: number;
    name: string;
    imageUrl: string | null;
    lineTotal: number;
    createdAt: Date;

    constructor(data: Partial<OrderItem>){
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.productId = data.productId!;
        this.quantity = data.quantity!;
        this.unitPrice = data.unitPrice!;
        this.name = data.name!;
        this.imageUrl = data.imageUrl ?? null;
        this.lineTotal = data.lineTotal!;
        this.createdAt = data.createdAt!;
    }
}
