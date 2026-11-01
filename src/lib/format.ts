import { useTranslation } from "react-i18next";

/// Dates in the interface language. Seconds are Unix epoch, days are `YYYY-MM-DD`.
export function useDateFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const fromSecs = (secs: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(new Date(secs * 1000));

  return {
    day: (secs: number) => fromSecs(secs, { day: "numeric", month: "short", year: "numeric" }),
    moment: (secs: number) => fromSecs(secs, { dateStyle: "long", timeStyle: "short" }),
    calendarDay: (day: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)),
  };
}
