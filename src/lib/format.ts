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

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/// File sizes in the interface language, in the largest unit that keeps the number readable.
export function useByteFormat() {
  const { i18n } = useTranslation();
  return (bytes: number) => {
    const exponent = bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0;
    const step = Math.min(exponent, BYTE_UNITS.length - 1);
    return new Intl.NumberFormat(i18n.language, {
      style: "unit",
      unit: BYTE_UNITS[step],
      maximumFractionDigits: step < 2 ? 0 : 1,
    }).format(bytes / 1024 ** step);
  };
}
