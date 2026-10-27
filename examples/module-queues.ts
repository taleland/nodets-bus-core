import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Event } from '@node-ts/bus-messages';
import { RabbitMqTransport } from '@node-ts/bus-rabbitmq';
import {
  type BusConfigureFactory,
  type GetBus,
  NODETS_BUS_CORE_SYMBOLS,
  NodeTsBusCoreModule,
} from '../src/index.js';

export class OrderPlaced extends Event {
  readonly $name = 'shop/order-placed';
  readonly $version = 1;

  constructor (public readonly orderId: string, public readonly eventId: string) {
    super();
  }
}

@Injectable()
export class BillingHandler implements OnModuleInit {
  readonly events: OrderPlaced[] = [];
  readonly received = Promise.withResolvers<OrderPlaced>();

  constructor (
    @Inject(NODETS_BUS_CORE_SYMBOLS.busConfigure)
    private readonly configure: BusConfigureFactory
  ) {}

  onModuleInit (): void {
    this.configure('billing').withHandler({
      messageType: OrderPlaced,
      messageHandler: event => {
        this.events.push(event);
        this.received.resolve(event);
      },
    });
  }
}

@Module({ providers: [BillingHandler], exports: [BillingHandler] })
export class BillingModule {}

@Injectable()
export class NotificationsHandler implements OnModuleInit {
  readonly events: OrderPlaced[] = [];
  readonly received = Promise.withResolvers<OrderPlaced>();

  constructor (
    @Inject(NODETS_BUS_CORE_SYMBOLS.busConfigure)
    private readonly configure: BusConfigureFactory
  ) {}

  onModuleInit (): void {
    this.configure('notifications').withHandler({
      messageType: OrderPlaced,
      messageHandler: event => {
        this.events.push(event);
        this.received.resolve(event);
      },
    });
  }
}

@Module({ providers: [NotificationsHandler], exports: [NotificationsHandler] })
export class NotificationsModule {}

export async function createExample (connectionString: string, queuePrefix = 'example') {
  const tokens = ['orders', 'billing', 'notifications'];
  const config = tokens.map(token => ({
    token,
    value: new RabbitMqTransport({
      connectionString,
      queueName: `${queuePrefix}.${token}`,
      deadLetterQueueName: `${queuePrefix}.${token}.dead-letter`,
      persistentMessages: true,
    }),
  }));

  @Module({
    imports: [NodeTsBusCoreModule.forRoot(config), BillingModule, NotificationsModule],
  })
  class AppModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: false }
  );
  const getBus = app.get<GetBus>(NODETS_BUS_CORE_SYMBOLS.getBusInstance);
  const close = async () => {
    const results = await Promise.allSettled(tokens.map(async token => {
      const instances = app.get<Map<string, { dispose(): Promise<void> }>>(
        NODETS_BUS_CORE_SYMBOLS.busMap
      );
      await instances.get(token)?.dispose();
    }));
    await app.close();
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length > 0) throw new AggregateError(errors.map(error => error.reason));
  };

  try {
    await app.init();
  } catch (error) {
    await close();
    throw error;
  }

  return {
    app,
    getBus,
    billing: app.get(BillingHandler),
    notifications: app.get(NotificationsHandler),
    close,
  };
}

async function main (): Promise<void> {
  const example = await createExample(process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await example.getBus('orders').publish(new OrderPlaced('order-123', randomUUID()));
    const copies = await Promise.race([
      Promise.all([example.billing.received.promise, example.notifications.received.promise]),
      new Promise<never>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for both modules')), 10000);
      }),
    ]);
    console.log('Each module received its own copy:', copies.map(event => event.eventId));
  } finally {
    clearTimeout(timeout);
    await example.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
