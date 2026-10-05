const MAX_ADDRESS_LENGTH = 128;

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** A dotted IPv4 address whose four octets are each 0 to 255. */
const isIpv4 = (text: string) =>
  IPV4.test(text) && text.split(".").every((octet) => Number(octet) <= 255);

/** An embedded dotted IPv4 tail as the two 16-bit groups it stands for. */
function ipv4Groups(ipv4: string): readonly string[] {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);

  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/**
 * The eight groups of an IPv6 address with `::` expanded, or `undefined` when
 * the text is not one.
 */
function ipv6Groups(address: string): readonly string[] | undefined {
  const halves = address.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const parse = (half: string | undefined) => {
    const groups = half ? half.split(":") : [];
    const last = groups.at(-1);

    // A tail with an octet over 255 stays a group, fails the hex check, and
    // leaves the address unparsed.
    return last !== undefined && isIpv4(last)
      ? [...groups.slice(0, -1), ...ipv4Groups(last)]
      : groups;
  };

  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;

  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }

  const zeros = Array.from({ length: missing }, () => "0");
  const groups = [...head, ...zeros, ...tail];

  return groups.every((group) => HEX_GROUP.test(group))
    ? groups.map((group) => Number.parseInt(group, 16).toString(16))
    : undefined;
}

/**
 * The key one caller's address is charged under. An IPv6 address is cut to its
 * /64, because one subscriber usually holds a whole /64 and could otherwise
 * draw a fresh budget from each of its addresses. An IPv4-mapped IPv6 address
 * is charged as the IPv4 address it carries. Anything unparseable is charged
 * as written, capped in length.
 */
export function addressKey(address: string): string {
  if (!address.includes(":")) {
    return address.slice(0, MAX_ADDRESS_LENGTH);
  }

  const groups = ipv6Groups(address.split("%")[0] ?? "");

  if (groups === undefined) {
    return address.slice(0, MAX_ADDRESS_LENGTH);
  }

  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff";

  if (isIpv4Mapped) {
    const [high = 0, low = 0] = groups
      .slice(6)
      .map((group) => Number.parseInt(group, 16));

    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }

  return `${groups.slice(0, 4).join(":")}::/64`;
}
