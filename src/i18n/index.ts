import { englishTranslation } from "@/i18n/en";
import type { Translate } from "@/i18n/type";

const t: Translate = (key) => englishTranslation[key];

export const useTranslation = (): { t: Translate } => ({ t });

const i18n = { t };

export default i18n;
