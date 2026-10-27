import { type FastifyBaseLogger } from 'fastify';
import type nodeTsBusCore from '@node-ts/bus-core';

export const nodetsBusAdaptPino = (
  logger: FastifyBaseLogger
): nodeTsBusCore.Logger => {
  return {
    debug (message, meta) {
      logger.debug(meta, message);
    },
    error (message, meta) {
      logger.error(meta, message);
    },
    fatal (message, meta) {
      logger.fatal(meta, message);
    },
    trace (message, meta) {
      logger.trace(meta, message);
    },
    warn (message, meta) {
      logger.warn(meta, message);
    },
    info (message, meta) {
      logger.info(meta, message);
    },
  };
};
