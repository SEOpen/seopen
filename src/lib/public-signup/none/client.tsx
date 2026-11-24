import type { UnconfirmedHelp as Help } from "../types";

/** No public sign-up (../types.ts), so no address is ever waiting to be confirmed. */
export const UnconfirmedHelp: Help = () => null;
