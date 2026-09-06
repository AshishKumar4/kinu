import type { CommandDispatcherInit, RegisteredProtocolCommand } from "../protocol/index.js";
import { CommandDispatcher } from "../protocol/index.js";
export interface ClosedCommandFamilies<Transaction, Read> {
    readonly bootstrap?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly authority?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly facets?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly runs?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly invocations?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly sourceRouting?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly targetRouting?: readonly RegisteredProtocolCommand<Transaction, Read>[];
}
export type ClosedDispatcherInit<Transaction, Read, ReadTransaction = Transaction> = Omit<CommandDispatcherInit<Transaction, Read, ReadTransaction>, "commands"> & {
    readonly commands: ClosedCommandFamilies<Transaction, Read>;
};
export declare function createClosedCommandDispatcher<Transaction, Read, ReadTransaction = Transaction>(init: ClosedDispatcherInit<Transaction, Read, ReadTransaction>): CommandDispatcher<Transaction, Read, ReadTransaction>;
