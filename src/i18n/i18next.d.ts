import "i18next";
import type { en } from "./en";
import type { ru } from "./ru";

declare module "i18next" {
  interface CustomTypeOptions {
    keySeparator: false;
    nsSeparator: false;
    defaultNS: "translation";
    resources: { translation: Record<keyof typeof en | keyof typeof ru, string> };
  }
}
