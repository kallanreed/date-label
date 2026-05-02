function pad(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}/${pad(map.month)}/${pad(map.day)}`;
}

export async function onRequest(context) {
  const timeZone = context.request.cf?.timezone || "UTC";
  const localDate = formatLocalDate(new Date(), timeZone);

  return new Response(localDate, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
