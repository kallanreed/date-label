function pad(value) {
  return String(value).padStart(2, "0");
}

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function formatLocalDateTime(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const utcMs = now.getTime();
  const localMs = Date.parse(
    `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`
  );
  const offsetMinutes = Math.round((localMs - utcMs) / 60000);

  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${formatOffset(offsetMinutes)}`;
}

export async function onRequest(context) {
  const timeZone = context.request.cf?.timezone || "UTC";
  const localDateTime = formatLocalDateTime(new Date(), timeZone);

  return new Response(localDateTime, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
