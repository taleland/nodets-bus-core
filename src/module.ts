import {
  Inject,
  Module,
  type DynamicModule,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { type FastifyInstance } from 'fastify';
import {
  Bus,
  type Transport as NodeTsTransport,
  type BusConfiguration,
  type BusInstance,
} from '@node-ts/bus-core';
import { HttpAdapterHost } from '@nestjs/core';
import { bus } from './bus.js';
import { busConfigure, type BusConfigureFactory } from './bus-configure.js';
import { NODETS_BUS_CORE_SYMBOLS } from './symbols.js';
import { nodetsBusAdaptPino } from './nodets-bus-adapter.js';

export type NodeTsBusCoreConfig = {
  token: string;
  value: NodeTsTransport;
}[];

@Module({
  providers: [bus, busConfigure],
  exports: [bus, busConfigure],
})
export class NodeTsBusCoreModule implements OnApplicationBootstrap {
  public constructor (
    @Inject(NODETS_BUS_CORE_SYMBOLS.busConfigure)
    private readonly busConfigure: BusConfigureFactory,
    @Inject(NODETS_BUS_CORE_SYMBOLS.busMap)
    private readonly busMap: Map<string, BusInstance>,
    @Inject(NODETS_BUS_CORE_SYMBOLS.config)
    private readonly config: NodeTsBusCoreConfig,
    private readonly httpAdapterHost: HttpAdapterHost
  ) {}

  public static forRoot (config: NodeTsBusCoreConfig): DynamicModule {
    const busConfigureMapProvider = {
      provide: NODETS_BUS_CORE_SYMBOLS.busConfigureMap,
      useValue: new Map<string, BusConfiguration>(
        config.map(transport => [transport.token, Bus.configure()])
      ),
    };

    const busMapProvider = {
      provide: NODETS_BUS_CORE_SYMBOLS.busMap,
      useValue: new Map<string, BusInstance>(),
    };

    return {
      module: NodeTsBusCoreModule,
      global: true,
      providers: [
        bus,
        busConfigure,
        {
          provide: NODETS_BUS_CORE_SYMBOLS.config,
          useValue: config,
        },
        busConfigureMapProvider,
        busMapProvider,
      ],
      exports: [bus, busConfigure, busMapProvider],
    };
  }

  public async onApplicationBootstrap () {
    await this.setupBus();
  }

  private async setupBus () {
    const fastifyInstance =
      this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();

    const promises = this.config.map(async config => {
      const busConfigure = this.busConfigure(config.token);

      busConfigure
        .withLogger(target =>
          nodetsBusAdaptPino(fastifyInstance.log.child({ target }))
        )
        .withTransport(config.value);

      const busInstance = busConfigure.build();

      this.busMap.set(config.token, busInstance);

      await busInstance.initialize();
      await busInstance.start();
    });

    await Promise.all(promises);
  }
}
