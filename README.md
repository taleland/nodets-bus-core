# @taleland/nodets-bus-core

NestJS integration for [node-ts bus](https://github.com/node-ts/bus), with named bus instances, transport configuration through dependency injection, and Fastify logging.

**Initial implementation for review. No npm release has been published from this repository.**

## Requirements

- Node.js 22.13 or newer (CI uses Node.js 24).
- NestJS 12 with the Fastify adapter, Fastify 5, and `reflect-metadata`.
- `@node-ts/bus-core` 1.3 and `@node-ts/bus-messages` 1.1.
- A transport and its infrastructure; the examples use `@node-ts/bus-rabbitmq` 1.1 and RabbitMQ.

This module reads the Fastify logger from `HttpAdapterHost`. Bootstrap a Nest HTTP application with `FastifyAdapter`, including when the process only runs workers. An Express adapter or a standalone Nest application context is not supported.

## Installation

After the initial release is approved and published:

```sh
npm install @taleland/nodets-bus-core @nestjs/common @nestjs/core @nestjs/platform-fastify fastify reflect-metadata @node-ts/bus-core @node-ts/bus-messages @node-ts/bus-rabbitmq
```

Until then, build and run the example from this checkout:

```sh
npm ci
npm run build
docker run --rm --name bus-example -p 5672:5672 rabbitmq:4-alpine
# In another terminal:
RABBITMQ_URL=amqp://guest:guest@localhost:5672 npm run example
```

## Configure and use a bus

Import `NodeTsBusCoreModule.forRoot([{ token, value: transport }])` once in the root module. Each token must be unique and identifies a separate bus configuration and instance. The module is global.

Configure message handlers in `onModuleInit`, before application bootstrap starts the transports:

```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  NODETS_BUS_CORE_SYMBOLS,
  type BusConfigureFactory,
  type GetBus,
} from '@taleland/nodets-bus-core';

@Injectable()
export class BillingHandler implements OnModuleInit {
  constructor(
    @Inject(NODETS_BUS_CORE_SYMBOLS.busConfigure)
    private readonly configure: BusConfigureFactory,
  ) {}

  onModuleInit(): void {
    this.configure('billing').withHandler({
      messageType: OrderPlaced,
      messageHandler: async event => {
        await recordBillingEvent(event.eventId, event.orderId);
      },
    });
  }
}
```

Here `OrderPlaced` is your event class and `recordBillingEvent` is application code. The complete runnable example below defines the event and both modules.

Use `@Inject(NODETS_BUS_CORE_SYMBOLS.getBusInstance)` with the `GetBus` type to obtain a bus factory in application services. Once `await app.init()` or `await app.listen(...)` completes:

```ts
const getBus = app.get<GetBus>(NODETS_BUS_CORE_SYMBOLS.getBusInstance);
await getBus('orders').publish(new OrderPlaced('order-123', crypto.randomUUID()));
```

`busConfigure(token)` rejects unknown tokens. `getBus(token)` rejects unavailable instances; do not publish during `onModuleInit`, before transport initialization has finished.

## A separate event copy for each module

Give each logical module a **different, stable RabbitMQ queue name**. Register the same event type on each module's bus. `RabbitMqTransport` automatically binds those queues to the durable fanout exchange named after the event's `$name`:

```text
orders bus publishes OrderPlaced ($name = shop/order-placed)
                         |
               shop/order-placed (fanout exchange)
                         |
             +-----------+------------+
             |                        |
      example.billing         example.notifications
             |                        |
       BillingModule           NotificationsModule
```

Both queues receive their own delivery of the event. The payload and `eventId` are the same; receiving a separate copy does not generate a new event identity.

- Different modules use different queues, so billing and notifications process independently.
- Replicas of the **same** module use the **same** queue, so they compete for deliveries. Giving replicas random queue names would duplicate work across replicas.
- The DI token identifies a bus inside Nest; it does not name the event exchange. The exchange is `OrderPlaced.$name`, not `$queueName`. No manual `bindQueue` call is needed for registered handlers.
- Start subscribers at least once before publishing so their durable queues and bindings exist. A fanout exchange does not retain messages for queues that have never been bound.
- Durable queues and persistent messages support recovery, but delivery can be repeated. Make each module's side effects idempotent, for example with a unique `(moduleName, eventId)` record in the same transaction as the side effect.
- Separate queues isolate consumer retries and acknowledgements. Keep dead-letter queue names separate as well when modules need independent failure handling.

### Complete example

This example runs three buses in one Nest application: one publisher and one consumer bus for each module. The same queue topology also works across separate deployments: keep the event contract and connection settings shared, and initialize only the buses needed by each deployment.

The integration test runs [this exact example](examples/module-queues.ts) against RabbitMQ and checks that both modules receive the event.

```ts
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
} from '@taleland/nodets-bus-core';

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
```

The wrapper initializes and starts buses during application bootstrap. It does not automatically dispose them on Nest shutdown. Dispose each bus before closing the application, as the example's `close()` function does. Long-running services should invoke the same cleanup from their shutdown lifecycle.

## Development

```sh
npm ci
npm run lint
npm run build
npm test
npm pack --dry-run
```

Docker is required for integration tests. `npm run test:unit` runs provider tests only; `npm run test:integration` verifies fanout delivery using an isolated RabbitMQ container. Build before either command. The npm tarball contains compiled library code and declarations, README, and changelog; examples and tests stay in the repository.

## Release preparation

The repository follows `taleland/nestjs-auth0`: shared TypeScript configuration, Conventional Commit PR titles, Dependabot, CI, and semantic-release with npm OIDC publishing. `AGENTS.md` is copied unchanged, including its local Conventional Commits specification.

Publishing is disabled until the repository variable `NPM_PUBLISH_ENABLED` is explicitly set to `true`. Before enabling it, approve the initial implementation, choose the package license (currently `UNLICENSED`), and configure npm Trusted Publishing for `taleland/nodets-bus-core`, workflow `publish.yml`, following npm's initial-package setup requirements. The workflow uses Node.js 24 and requires no stored `NPM_TOKEN`. Initial review does not create a release.
