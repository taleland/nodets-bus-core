import {
  type ClassConstructor,
  type HandlerDefinition,
  type MessageBase,
} from '@node-ts/bus-core';
import { type MessageAttributes } from '@node-ts/bus-messages';

export type Handler<
  Message extends MessageBase,
  MessageAttributesType extends MessageAttributes = MessageAttributes
> = {
  messageType: ClassConstructor<Message>;
  messageHandler: HandlerDefinition<Message, MessageAttributesType>;
};
