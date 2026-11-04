import {connect} from "amqp-connection-manager";
import type {AmqpConnectionManager, ChannelWrapper} from "amqp-connection-manager";
import type {ConfirmChannel, ConsumeMessage as AmqpConsumeMessage} from "amqplib";
import type {ConsumeMessage, ConsumerOptions, IMessageBroker, MessageHandler} from "../message-broker.interface.js";
import type {RabbitMQConfig} from "./rabbitmq.types.js";

// 1 TCP connection -> many cheap channels.
// Each ChannelWrapper reconnects by itself and re-runs its `setup(ch)` every time the
// underlying channel reopens, so topology + consumers come back after a broker restart.
// One long-lived publisher channel; one channel per consumer.
export class RabbitMQClient implements IMessageBroker {
    private connection: AmqpConnectionManager | null = null;
    private publishChannel: ChannelWrapper | null = null;
    private readonly consumerChannels: ChannelWrapper[] = [];

    constructor(private readonly config: RabbitMQConfig){}

    async connect(): Promise<void> {
        if(this.connection){
            return;
        }
        this.connection = connect([this.config.url], {reconnectTimeInSeconds: this.config.reconnectTimeInSeconds});
        this.connection.on("disconnect", ({err}) => {console.error("[rabbitmq] disconnected:", err?.message);});

        // a ConfirmChannel setup -> publisher confirms are on (broker acks every publish)
        this.publishChannel = this.connection.createChannel({
            json: false,
            setup: async (_channel: ConfirmChannel) => {}
        });
        await this.publishChannel.waitForConnect();
    }

    async close(): Promise<void> {
        for(const channel of this.consumerChannels){
            await channel.close().catch(() => {});
        }
        this.consumerChannels.length = 0;
        await this.publishChannel?.close().catch(() => {});
        await this.connection?.close().catch(() => {});
        this.publishChannel = null;
        this.connection = null;
    }

    // asserts exchange / DLX / DLQ / queue / bindings on a throwaway channel
    async declareTopology(options: ConsumerOptions): Promise<void> {
        const connection = await this.requireConnection();
        const channel = connection.createChannel({
            json: false,
            setup: (ch: ConfirmChannel) => assertTopology(ch, options)
        });
        await channel.waitForConnect();
        await channel.close();
    }

    async consume(options: ConsumerOptions, handler: MessageHandler): Promise<void> {
        const connection = await this.requireConnection();
        const channel = connection.createChannel({
            json: false,
            setup: async (ch: ConfirmChannel) => {
                await assertTopology(ch, options);
                await ch.prefetch(options.prefetch);
                await ch.consume(options.queue, (raw) => handleMessage(ch, raw, handler), {noAck: false});
            }
        });
        this.consumerChannels.push(channel);
        await channel.waitForConnect();
    }

    // persistent + durable queue -> survives a broker restart
    async publish(exchange: string, routingKey: string, body: Buffer): Promise<void> {
        await this.requireConnection();
        await this.publishChannel!.publish(exchange, routingKey, body, {
            persistent: true,
            contentType: "application/json"
        });
    }

    private async requireConnection(): Promise<AmqpConnectionManager> {
        await this.connect();
        return this.connection!;
    }
}

// "assert" = create if missing, verify if present. Always idempotent.
async function assertTopology(ch: ConfirmChannel, options: ConsumerOptions): Promise<void> {
    await ch.assertExchange(options.exchange, "topic", {durable: true});

    if(options.deadLetterExchange && options.deadLetterQueue){
        await ch.assertExchange(options.deadLetterExchange, "topic", {durable: true});
        await ch.assertQueue(options.deadLetterQueue, {durable: true});
        await ch.bindQueue(options.deadLetterQueue, options.deadLetterExchange, "#");
    }

    const queueArgs: Record<string, string> = {};
    if(options.deadLetterExchange){
        queueArgs["x-dead-letter-exchange"] = options.deadLetterExchange;
    }

    await ch.assertQueue(options.queue, {durable: true, arguments: queueArgs});
    for(const key of options.bindingKeys){
        await ch.bindQueue(options.queue, options.exchange, key);
    }
}

// wraps the amqplib message in the broker-agnostic shape; a handler that throws -> nack (no requeue -> DLQ)
async function handleMessage(ch: ConfirmChannel, raw: AmqpConsumeMessage | null, handler: MessageHandler): Promise<void> {
    if(!raw){
        return; // consumer cancelled by the broker
    }

    let settled = false;
    const msg: ConsumeMessage = {
        routingKey: raw.fields.routingKey,
        body: raw.content,
        ack: () => {
            if(settled) return;
            settled = true;
            ch.ack(raw);
        },
        nack: (requeue = false) => {
            if(settled) return;
            settled = true;
            ch.nack(raw, false, requeue);
        }
    };

    try{
        await handler(msg);
    }catch(err){
        console.error("[rabbitmq] handler threw:", (err as Error).message);
        msg.nack(false);
    }
}
