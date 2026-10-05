import { describe, expect, it } from "vitest";

import { addressKey } from "../src/client-address.ts";

describe("addressKey", () => {
  it.each([
    ["198.51.100.7", "198.51.100.7"],
    ["unknown", "unknown"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002::", "2001:db8:1:2::/64"],
    ["2001:DB8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["::ffff:c633:6407", "198.51.100.7"],
    ["64:ff9b::198.51.100.7", "64:ff9b:0:0::/64"],
  ])("charges %s as %s", (address, key) => {
    expect(addressKey(address)).toBe(key);
  });

  it.each([
    "2001:db8::1::2",
    "2001:db8:1:2:3:4:5:6:7",
    "2001:db8:1:2:3:4:5",
    "2001:db8:zz::1",
    "::ffff:1.300.0.0",
    "::ffff:256.0.0.1",
  ])("charges the unparseable %s as written", (address) => {
    expect(addressKey(address)).toBe(address);
  });

  it("caps an unparseable address at 128 characters", () => {
    expect(addressKey(`:${"x".repeat(200)}`)).toHaveLength(128);
  });
});
