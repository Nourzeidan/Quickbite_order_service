export interface ConsumeMessage {
    routingKey: string;
    body: Buffer;
    ack(): void;
    nack(requeue?: boolean): void;
}

export interface ConsumerOptions {
    exchange: string;
    queue: string;
    bindingKeys: string[];
    deadLetterExchange?: string;
    deadLetterQueue?: string;
    prefetch: number;
}

export type MessageHandler = (msg: ConsumeMessage) => Promise<void>;

export interface IMessageBroker {
    connect(): Promise<void>;
    close(): Promise<void>;
    declareTopology(options: ConsumerOptions): Promise<void>;
    consume(options: ConsumerOptions, handler: MessageHandler): Promise<void>;
    publish(exchange: string, routingKey: string, body: Buffer): Promise<void>;
}
