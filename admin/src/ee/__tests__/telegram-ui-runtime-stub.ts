/*
 * The Lexical runtime suite exercises the production editor conversion module
 * in Node. Strapi's UI packages are browser-only in this repository, so their
 * render-only exports are replaced while the real Lexical implementation runs.
 */
const component = () => null;

export const Box = component;
export const Flex = component;
export const IconButton = component;
export const IconButtonGroup = component;
export const SingleSelect = component;
export const SingleSelectOption = component;

export const ArrowClockwise = component;
export const ArrowsCounterClockwise = component;
export const Bold = component;
export const BulletList = component;
export const Code = component;
export const Italic = component;
export const Link = component;
export const Minus = component;
export const NumberList = component;
export const StrikeThrough = component;
export const Underline = component;

const styledFactory = () => component;
export const styled = Object.assign(
  (_base: unknown) => styledFactory,
  { span: styledFactory }
);
