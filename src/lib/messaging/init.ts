import {env} from "../config/env.js";
import {RabbitMQClient} from "../../pkg/messaging/rabbitmq/rabbitmq.client.js";

export const messageBroker = new RabbitMQClient({
    url: env.rabbit.url,
    reconnectTimeInSeconds: 5,
});
