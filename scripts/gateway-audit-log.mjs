const GUARDIAN_AUDIT_PREFIX =
  '{"schemaVersion":1,"component":"dataops-guardian"';

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  throw new Error("unterminated dataops-guardian audit event in Gateway log");
}

function extractFromText(text) {
  const events = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(GUARDIAN_AUDIT_PREFIX, cursor);
    if (start < 0) {
      break;
    }

    const end = findJsonObjectEnd(text, start);
    events.push(JSON.parse(text.slice(start, end)));
    cursor = end;
  }

  return events;
}

export function extractGuardianAuditEvents(gatewayLog) {
  const directEvents = extractFromText(gatewayLog);
  if (directEvents.length > 0) {
    return directEvents;
  }

  return extractFromText(gatewayLog.replaceAll('\\"', '"'));
}
