---
author: StevenPG
pubDatetime: 2026-10-27T12:00:00.000Z
title: "Java 28 Has a Built-in JSON API: A Practical Intro to JEP 540"
slug: java-28-built-in-json-api-jep-540
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - json
description: "Java 28 adds a built-in JSON API (JEP 540, jdk.incubator.json): parse, navigate and generate JSON with no Jackson and no dependencies. Every method, with code and output from JDK 28 EA, plus where Jackson still wins."
---

## Table of Contents

[[toc]]

# Java finally ships its own JSON parser

**Java 28 includes a JSON API in the JDK.** [JEP 540: Simple JSON API (Incubator)](https://openjdk.org/jeps/540)
adds the `jdk.incubator.json` module. With it you can parse a JSON document,
walk it, pull values out, and write JSON back out, with no Jackson, no Gson and
no dependency at all.

The short version:

- **Module:** `jdk.incubator.json`, enabled with `--add-modules jdk.incubator.json`
- **Status:** Integrated into JDK 28 as an _incubator_ API. JDK 28 is scheduled for
  GA on March 23, 2027, and early-access builds are out now.
- **Does:** strict [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) parsing into an
  immutable tree, navigation, conversion to Java types, compact and pretty output
- **Does not do:** data binding to your classes, streaming, comments, trailing commas,
  or any lenient mode
- **API size:** one utility class (`Json`), one sealed interface (`JsonValue`) with
  six subtypes, and two exceptions

This is the second attempt. [JEP 198](https://openjdk.org/jeps/198) proposed a
"Light-Weight JSON API" in 2014 and never shipped. JEP 540 replaces it with a
much smaller design built on features Java didn't have in 2014: sealed
interfaces, pattern matching and `Optional`.

I wanted to know what it's actually like to use, so I wrote seven small programs
covering the whole API and ran them on JDK 28 early-access build 21. Every code
block and every piece of output below comes from those runs. The project is
[DemosAndArticleContent/blog/java-28-json-api](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-28-json-api).
Every demo is a single file you start with `java`. There's no build tool and
nothing to download except the JDK.

# Setting up JDK 28 and the incubator module

Download an early-access build from [jdk.java.net/28](https://jdk.java.net/28/).
Incubator modules aren't resolved by default, so every compile and every run
needs one flag:

```bash
java --add-modules jdk.incubator.json Forecast.java
```

The JVM reminds you each time:

```
WARNING: Using incubator modules: jdk.incubator.json
```

The source launcher passes `--add-modules` through to the compiler as well. In a
real build the flag has to reach `javac`, the test JVM and the runtime JVM:

```kotlin
// build.gradle.kts
java { toolchain { languageVersion = JavaLanguageVersion.of(28) } }
tasks.withType<JavaCompile> { options.compilerArgs.addAll(listOf("--add-modules", "jdk.incubator.json")) }
tasks.withType<Test> { jvmArgs("--add-modules", "jdk.incubator.json") }
tasks.withType<JavaExec> { jvmArgs("--add-modules", "jdk.incubator.json") }
```

In a modular application, `requires jdk.incubator.json;` in `module-info.java`
replaces the flag.

> **Incubator means changeable.** The package name and the methods can change, or the
> whole module can be removed, before the API is finalized. Use it in tools, scripts and
> internal services today. Don't put it in a library's public API yet.

# The whole API on one screen

`JsonValue` is a **sealed** interface. Every parsed value is exactly one of six
types, one for each kind of JSON value:

```
JsonValue (sealed)
├── JsonObject    {"name": value, ...}
├── JsonArray     [value, ...]
├── JsonString    "text"
├── JsonNumber    123, 4.5, 6E7
├── JsonBoolean   true, false
└── JsonNull      null
```

You rarely need to name those subtypes, though. The navigation and conversion
methods are declared on `JsonValue` itself, so you chain them without casting.
Call one on the wrong type and it throws `JsonValueException`.

## Java 28 JSON API cheat sheet

| Method                                                              | Called on | Returns                                 | Throws `JsonValueException` when         |
| ------------------------------------------------------------------- | --------- | --------------------------------------- | ---------------------------------------- |
| `Json.parse(String)` / `Json.parse(char[])`                         | n/a       | `JsonValue`                             | never: throws `JsonParseException`       |
| `get(String name)`                                                  | object    | member's `JsonValue`                    | not an object, or member missing         |
| `get(int index)`                                                    | array     | element's `JsonValue`                   | not an array, or index out of bounds     |
| `tryGet(String name)`                                               | object    | `Optional<JsonValue>`, empty if missing | not an object                            |
| `tryValue()`                                                        | anything  | `Optional<JsonValue>`, empty if `null`  | never                                    |
| `asString()`                                                        | string    | `String` (escapes decoded)              | not a string                             |
| `asInt()` / `asLong()`                                              | number    | `int` / `long`                          | not a number, or not exactly convertible |
| `asDouble()`                                                        | number    | `double` (rounded to nearest)           | not a number, or out of `double` range   |
| `asBoolean()`                                                       | boolean   | `boolean`                               | not a boolean                            |
| `asMap()`                                                           | object    | unmodifiable `Map<String, JsonValue>`   | not an object                            |
| `asList()`                                                          | array     | unmodifiable `List<JsonValue>`          | not an array                             |
| `toString()`                                                        | anything  | compact JSON text                       | never                                    |
| `Json.toDisplayString(value, indent)`                               | n/a       | pretty-printed JSON text                | never                                    |
| `JsonObject.of(Map)`, `JsonArray.of(List)`                          | n/a       | new object / array                      | `IllegalArgumentException` on bad input  |
| `JsonString.of`, `JsonNumber.of`, `JsonBoolean.of`, `JsonNull.of()` | n/a       | new primitive value                     | `IllegalArgumentException` on bad input  |

That really is the whole public API.

# Parsing and navigating JSON in Java 28

The JEP's main example averages the temperatures in a U.S. National Weather
Service forecast. Here it is against the real NWS response shape:

```java
JsonValue root = Json.parse(body);

root.get("properties").get("periods").asList().stream()
        .mapToInt(p -> p.get("temperature").asInt())
        .average()
        .ifPresent(avg -> IO.println("Average forecast temperature: %.1f F%n".formatted(avg)));
```

There are no casts and no DTO classes. `get("properties")` returns a `JsonValue`,
and you call `get` on that again. `asList()` hands you an ordinary
`List<JsonValue>`, so the rest is the `Stream` code you already write.

The full demo (`src/Forecast.java`) goes on to print a table of the forecast
periods. Here is its output against the bundled sample:

```
Average forecast temperature: 61.2 F

Period            Temp  Precip Gusts    Forecast
Today             74 F  -      -        Sunny
Tonight           51 F  -      -        Clear
Tuesday           71 F  10%    25 mph   Mostly Sunny
Tuesday Night     53 F  20%    -        Partly Cloudy
Wednesday         66 F  40%    30 mph   Chance Light Rain
Wednesday Night   52 F  30%    -        Chance Light Rain

Gridpoint elevation: 21.9 m
Members on properties: [units, forecastGenerator, generatedAt, updateTime, validTimes, elevation, periods]
```

Two things to note. Members come back from `asMap()` **in document order**, so
the parser keeps the order it read them in. And the "Precip" and "Gusts" columns
are where real-world JSON gets awkward. The next section covers them.

Pass `--live` to fetch the actual forecast from `api.weather.gov` with
`java.net.http.HttpClient`. That's still zero dependencies. One catch: NWS
rejects requests that don't send a `User-Agent` header.

# Missing members vs. null values: `tryGet` and `tryValue`

JSON has two different ways of saying "no value," and the API gives each one its
own method:

| The JSON looks like | `get("x")`                  | `tryGet("x")`        | `get("x").tryValue()` |
| ------------------- | --------------------------- | -------------------- | --------------------- |
| `{"x": 5}`          | `JsonNumber 5`              | `Optional[5]`        | `Optional[5]`         |
| `{"x": null}`       | `JsonNull`                  | `Optional[JsonNull]` | `Optional.empty`      |
| `{}`                | throws `JsonValueException` | `Optional.empty`     | throws                |

The NWS forecast has both cases. `windGust` only appears on some periods, so
it's missing on the others. `probabilityOfPrecipitation.value` is always there,
but it's sometimes `null`:

```java
// Member that only appears on some periods: tryGet.
String gusts = p.tryGet("windGust").map(JsonValue::asString).orElse("-");

// Member that is always present but may be null: tryValue.
String precip = p.get("probabilityOfPrecipitation").get("value").tryValue()
        .map(v -> v.asInt() + "%")
        .orElse("-");
```

If you want "missing or null" treated the same, chain the two:
`tryGet("x").flatMap(JsonValue::tryValue)`.

## A null-heavy example: ADS-B state vectors

Weather data is tidy compared with flight-tracking data. The
[OpenSky Network](https://openskynetwork.github.io/opensky-api/rest.html) REST
API returns each aircraft as a **positional array**, not an object, and more
than half the slots can be `null` until the transponder reports them:

```json
["a8c4d2", "SWA3307 ", "United States", null, 1793109596, null, null, null, false, null, ...]
```

`src/AircraftStates.java` turns those arrays into records with `get(int)` and
`tryValue()`:

```java
record Position(double longitude, double latitude, Double baroAltitudeMetres) {}

static StateVector from(JsonValue s) {
    Optional<Position> position = s.get(5).tryValue().isPresent() && s.get(6).tryValue().isPresent()
            ? Optional.of(new Position(s.get(5).asDouble(), s.get(6).asDouble(), nullableDouble(s.get(7))))
            : Optional.empty();

    return new StateVector(
            s.get(0).asString(),
            // null on the wire, or blank padding: both mean "no callsign".
            s.get(1).tryValue().map(JsonValue::asString).map(String::strip).filter(cs -> !cs.isEmpty()),
            s.get(2).asString(),
            position,
            s.get(8).asBoolean(),
            nullableDouble(s.get(9)),
            s.get(14).tryValue().map(JsonValue::asString),
            // Arrays can be shorter than you expect; asList().size() guards get(int).
            s.asList().size() > 17 ? CATEGORIES.get(s.get(17).asInt()) : "n/a");
}

static Double nullableDouble(JsonValue v) {
    return v.tryValue().map(JsonValue::asDouble).orElse(null);
}
```

OpenSky also sends `"states": null` when the bounding box is empty. That's one
more `tryValue()`:

```java
List<StateVector> states = root.get("states").tryValue()
        .map(JsonValue::asList)
        .orElse(List.of())
        .stream()
        .map(StateVector::from)
        .toList();
```

The output, sorted by altitude. The data is synthetic, but the nulls fall where
the real feed puts them:

```
ICAO24  Callsign  Country        Level    GS kt  Sqwk  Category
3c66a1  DLH402    Germany        FL400      483  6021  Heavy
4ca7b9  EIN104    Ireland        FL380      490  5163  Heavy
a1f6e3  UAL278    United States  FL360      460  2216  Heavy
a0b77c  DAL1166   United States  FL260      386  4615  Large
ab3f07  N512SP    United States  FL045      119  1200  Light
a4b2c1  AAL1942   United States  FL035      180  3341  Large
a3994f  -         United States  FL020      100  -     No info
a6d5e4  N77MED    United States  FL015       80  7700  Rotorcraft   << EMERGENCY
a8c4d2  SWA3307   United States  ?            -  -     Large
a2e981  -         United States  GND          0  -     Service vehicle

At or above FL300: 3   No position yet: 1
```

# Pattern matching on JsonValue

Because `JsonValue` is sealed, a `switch` over it is **exhaustive with no
`default` branch**. That makes a generic tree walker about 15 lines.
`src/ThreadDumpSchema.java` uses one to print a "schema sketch" of a document
it has never seen: every path, and every JSON type found at that path.

```java
void walk(String path, JsonValue value, Map<String, Set<String>> schema) {
    String type = switch (value) {
        case JsonObject o -> {
            o.asMap().forEach((name, member) -> walk(path + "/" + name, member, schema));
            yield "object";
        }
        case JsonArray a -> {
            a.asList().forEach(element -> walk(path + "[]", element, schema));
            yield "array";
        }
        case JsonString _ -> "string";
        case JsonNumber _ -> "number";
        case JsonBoolean _ -> "boolean";
        case JsonNull _ -> "null";
    };
    schema.computeIfAbsent(path.isEmpty() ? "/" : path, _ -> new TreeSet<>()).add(type);
}
```

For something to point it at, the demo asks the running JVM to dump its own
threads as JSON through `HotSpotDiagnosticMXBean`. That's the same format
`jcmd <pid> Thread.dump_to_file -format=json` writes:

```
/threadDump                                                  object
/threadDump/formatVersion                                    number
/threadDump/processId                                        number
/threadDump/runtimeVersion                                   string
/threadDump/threadContainers[]/container                     string
/threadDump/threadContainers[]/owner                         null
/threadDump/threadContainers[]/parent                        null | string
/threadDump/threadContainers[]/threadCount                   number
/threadDump/threadContainers[]/threads[]/name                string
/threadDump/threadContainers[]/threads[]/parkBlocker/object  string
/threadDump/threadContainers[]/threads[]/stack[]             string
/threadDump/threadContainers[]/threads[]/state               string
/threadDump/threadContainers[]/threads[]/tid                 number
/threadDump/threadContainers[]/threads[]/waitingOn           string
...
```

`parent` shows up as `null | string`, and that's exactly the situation
`tryValue()` exists for. Pass the program any JSON file and it'll map that file
the same way.

Type patterns also handle documents whose format changed between versions. In
JDK 26 and earlier, thread dumps wrote `tid` as a JSON string. From JDK 27 on
it's a number. One switch reads both:

```java
long tid = switch (thread.get("tid")) {
    case JsonNumber n -> n.asLong();
    case JsonString s -> Long.parseLong(s.asString());
    default -> throw new JsonValueException("Unexpected type for \"tid\": " + thread.get("tid"));
};
```

# Generating JSON with Java 28

There's no builder and no `ObjectMapper`. You get factory methods:
`JsonObject.of(Map)`, `JsonArray.of(List)`, `JsonString.of`, `JsonNumber.of`,
`JsonBoolean.of` and `JsonNull.of()`. Used raw, they look like this:

```java
JsonValue raw = JsonObject.of(Map.of(
        "type", JsonString.of("Point"),
        "coordinates", JsonArray.of(List.of(JsonNumber.of(-75.2412), JsonNumber.of(39.8721)))));
// {"type":"Point","coordinates":[-75.2412,39.8721]}
```

That works, but nobody wants to write it twice. The JEP says outright that the
API is a minimal base for you to build your own layers on. Here's one layer:
two methods that turn ordinary Java values into `JsonValue`s.

```java
JsonObject obj(Object... nameValuePairs) {
    var members = new LinkedHashMap<String, JsonValue>();
    for (int i = 0; i < nameValuePairs.length; i += 2) {
        members.put((String) nameValuePairs[i], json(nameValuePairs[i + 1]));
    }
    return JsonObject.of(members);
}

JsonValue json(Object o) {
    return switch (o) {
        case null -> JsonNull.of();
        case JsonValue v -> v;
        case String s -> JsonString.of(s);
        case Integer i -> JsonNumber.of(i);
        case Long l -> JsonNumber.of(l);
        case Double d -> JsonNumber.of(d);
        case Boolean b -> JsonBoolean.of(b);
        case List<?> list -> JsonArray.of(list.stream().map(this::json).toList());
        default -> throw new IllegalArgumentException("No JSON mapping for " + o.getClass());
    };
}
```

With those two methods, building flight tracks as GeoJSON reads like the GeoJSON itself:

```java
JsonValue toFeature(Track t) {
    return obj(
            "type", "Feature",
            "geometry", obj(
                    "type", "LineString",
                    // GeoJSON is [longitude, latitude, altitude], the reverse of how pilots say it.
                    "coordinates", t.positions().stream()
                            .map(p -> List.of(p.longitude(), p.latitude(), Math.round(p.altitudeFt() * 0.3048)))
                            .toList()),
            "properties", obj(
                    "callsign", t.callsign(),
                    "icao24", t.icao24(),
                    "military", t.military(),
                    "squawk", t.squawk(),               // null -> JSON null
                    "points", t.positions().size()));
}
```

`toString()` gives you compact output. `Json.toDisplayString(value, "  ")`
pretty-prints with whatever indent string you pass. The demo writes
`out/tracks.geojson`, which you can paste into [geojson.io](https://geojson.io)
to see the tracks.

Three things I learned while writing this:

1. **Member order follows the map you pass in.** `JsonObject.of` keeps your
   map's iteration order, so use a `LinkedHashMap` or another `SequencedMap`.
   `Map.of` has no defined order.
2. **`JsonNumber.of(double)` writes exactly what the `double` holds.** My first
   run printed altitudes like `670.5600000000001`. Round before you generate.
3. **`JsonValue` doesn't define `equals`.** The javadoc says so directly. A
   reparsed document is `!equals` to the original. To compare documents,
   compare `toString()`. That's reliable, because the parser keeps document
   order and the source text of numbers:

```
Round trip equal (by toString): true
Round trip equal (by equals):   false  <- unspecified, don't rely on it
```

# The parser is strict, and that's deliberate

The parser has no "lenient" switch. It accepts RFC 8259 and nothing else.
`src/Strictness.java` feeds it 17 inputs. Here are the results on JDK 28-ea+21:

| Input                          | Result | Message (trimmed)                                                  |
| ------------------------------ | ------ | ------------------------------------------------------------------ |
| `{"callsign": "AAL1942", ...}` | OK     |                                                                    |
| `42` (top-level scalar)        | OK     |                                                                    |
| `"just a string"`              | OK     |                                                                    |
| Duplicate member name          | Reject | `Duplicate member name: "squawk" was already parsed.`              |
| `[1, 2, 3,]` trailing comma    | Reject | `Unexpected value. Expected a JSON Object, Array, String, ...`     |
| `// comment`                   | Reject | `Expecting a JSON Object member name.`                             |
| `{'alt': 1100}` single quotes  | Reject | `Expecting a JSON Object member name.`                             |
| `{alt: 1100}` unquoted name    | Reject | `Expecting a JSON Object member name.`                             |
| `0123` leading zero            | Reject | `Invalid position of '0' within JSON Number.`                      |
| `NaN`, `Infinity`              | Reject | `Unexpected value. Expected a JSON Object, Array, String, ...`     |
| `+1`                           | Reject | `Invalid position of '+' within JSON Number.`                      |
| `0x1F`                         | Reject | `Unexpected content after JSON value.`                             |
| Raw tab inside a string        | Reject | `Unescaped control code.`                                          |
| `{} {}` two documents          | Reject | `Additional value(s) were found after the JSON Value.`             |
| Empty string                   | Reject | `Expected a JSON Object, Array, String, Number, Boolean, or Null.` |

**Duplicate names are always an error.** That's the one most likely to bite you.
Jackson keeps the last duplicate by default and so does Go's `encoding/json` v1.
The JEP argues that an object with two `"squawk"` members means different things
to different parsers, and that's a real security problem. I agree. If you've
read my post on [Go 1.27's encoding/json/v2](/posts/go-1-27-encoding-json-v2/),
Go reached the same conclusion in the same year.

Every `JsonParseException` includes a path and a location:

```
Duplicate member name: "squawk" was already parsed. Path: "{". Location: line 2, position 2.
```

**Line and position are zero-based**, both in the message and in
`getErrorLine()` / `getErrorPosition()`. "Line 2" above is the third line of
the input. Add one before you show it to a person.

For hand-edited config files with `#` comments, the JEP's own advice is to strip
them before parsing:

```java
JsonValue config = Json.parse(jsonc.replaceAll("(?m)^\\s*#.*$", ""));
```

# JSON numbers: exact, rounded, or BigDecimal

A JSON number can have any precision. Java's primitives can't. Each conversion
method has its own rule:

- `asInt()` and `asLong()` succeed **only if the conversion is exact**.
- `asDouble()` **rounds** to the nearest `double`, but throws rather than return `Infinity`.
- For anything else, `new BigDecimal(value.toString())` is lossless.

From `src/Numbers.java`:

```
JSON text                          asInt()             asLong()               asDouble()             BigDecimal
123.0                              123                 123                    123.0                  123.0
234.56E2                           23456               23456                  23456.0                23456
345.6                              JsonValueException  JsonValueException     345.6                  345.6
2147483648                         JsonValueException  2147483648             2.147483648E9          2147483648
9007199254740993                   JsonValueException  9007199254740993       9.007199254740992E15   9007199254740993
9223372036854775808                JsonValueException  JsonValueException     9.223372036854776E18   9223372036854775808
-0                                 0                   0                      -0.0                   0
3.141592653589793238462643383279   JsonValueException  JsonValueException     3.141592653589793      3.1415926535897932384626433...
1.8E309                            JsonValueException  JsonValueException     JsonValueException     180000000000000000000000000...
1E-400                             JsonValueException  JsonValueException     0.0                    0.0000000000000000000000000...
```

Look at the `9007199254740993` row (2^53 + 1). `asLong()` returns it exactly.
`asDouble()` silently turns it into `...992`, which is what JavaScript does to
the same number. Use `asLong()` for IDs, never `asDouble()`.

`toString()` also returns a number's **source text**, so `[1.10, 1E2, 0.000]`
round-trips as `[1.10,1E2,0.000]`. Nothing gets normalized. That's what makes
the `BigDecimal` path lossless:

```java
BigDecimal total = Json.parse("[19.99, 0.01, 4.10]").asList().stream()
        .map(v -> new BigDecimal(v.toString()))
        .reduce(BigDecimal.ZERO, BigDecimal::add);   // 24.10, not 24.099999...
```

# What about records? There's no data binding

Mapping JSON straight onto your classes is out of scope. The JEP says so
plainly, and it's the biggest difference from Jackson. Records and reflection
still get you surprisingly far. `src/RecordBinding.java` is about 60 lines that
bind JSON to records (and records back to JSON). It handles `String`, the
primitives, enums, `BigDecimal`, nested records, `List<T>` and `Optional<T>`:

```java
record Period(
        int number,
        String name,
        boolean isDaytime,
        int temperature,
        String temperatureUnit,
        Optional<String> temperatureTrend,      // present-but-null in the feed
        Precipitation probabilityOfPrecipitation,
        String windSpeed,
        Optional<String> windGust,              // absent on most periods
        Compass windDirection,
        String shortForecast) {}

Forecast forecast = bind(root, Forecast.class);
```

The core of it is one switch on the target `Type`:

```java
Object result = switch (type) {
    case Class<?> c when c == String.class -> json.asString();
    case Class<?> c when c == int.class || c == Integer.class -> json.asInt();
    // ... long, double, boolean, BigDecimal
    case Class<?> c when c.isEnum() -> enumConstant(c, json.asString());
    case Class<?> c when c.isRecord() -> bindRecord(json, c);
    case ParameterizedType p when p.getRawType() == List.class ->
            json.asList().stream().map(e -> bind(e, p.getActualTypeArguments()[0])).toList();
    case ParameterizedType p when p.getRawType() == Optional.class ->
            json.tryValue().map(e -> bind(e, p.getActualTypeArguments()[0]));
    default -> throw new IllegalArgumentException("Unsupported type: " + type);
};
```

Bind into the wrong type and the error is still good, because the API
reports where in the document it failed:

```
JsonNumber is not a JsonString. Path: "{properties{periods[0{temperature". Location: line 41, position 23.
```

This binder doesn't handle renamed fields, polymorphism, custom date formats,
generics beyond one level, or any of the other 200 things Jackson does. At that
point you want Jackson. That's the honest dividing line.

# Java 28 JSON API vs Jackson

`jackson-comparison/SideBySide.java` in the demo project does five jobs both
ways, running against Jackson 3.2.4. Both libraries give identical results for
the first four.

**Navigating a tree.** It's nearly the same code:

```java
// JDK 28
Json.parse(body).get("properties").get("periods").asList().stream()
        .mapToInt(p -> p.get("temperature").asInt())
        .average();

// Jackson 3
mapper.readTree(body).get("properties").get("periods").valueStream()
        .mapToInt(p -> p.get("temperature").asInt())
        .average();
```

**Missing and null.** The JDK returns `Optional`. Jackson has the "missing
node" and default values:

```java
// JDK 28
String gust = period.tryGet("windGust").map(JsonValue::asString).orElse("-");

// Jackson 3
String gust = period.path("windGust").asString("-");
```

**Building a document.** Jackson's mutable `ObjectNode` is shorter. The JDK's
values are immutable:

```java
// JDK 28
var members = new LinkedHashMap<String, JsonValue>();
members.put("type", JsonString.of("Point"));
members.put("coordinates", JsonArray.of(List.of(JsonNumber.of(-75.2412), JsonNumber.of(39.8721))));
JsonValue doc = JsonObject.of(members);

// Jackson 3
ObjectNode doc = mapper.createObjectNode();
doc.put("type", "Point");
doc.putArray("coordinates").add(-75.2412).add(39.8721);
```

**Binding to records.** Jackson does it in one call. With the JDK you write the
mapping yourself:

```java
// JDK 28
List<Period> periods = Json.parse(body).get("properties").get("periods").asList().stream()
        .map(p -> new Period(
                p.get("name").asString(),
                p.get("temperature").asInt(),
                p.tryGet("windGust").map(JsonValue::asString)))
        .toList();

// Jackson 3
List<Period> periods = mapper.readValue(json,
        mapper.getTypeFactory().constructCollectionType(List.class, Period.class));
```

**Duplicate names.** This is where they actually disagree:

```
jdk=rejected  jackson(default)={"squawk":"7700"}  jackson(strict)=rejected
```

Jackson keeps the last value unless you turn on
`StreamReadFeature.STRICT_DUPLICATE_DETECTION`.

## When to use which

| You need...                                                         | Use                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A script, CLI tool, or `java Foo.java` program that reads JSON      | **JDK 28** (`jdk.incubator.json`)                                                                                         |
| To pull a few fields out of an API response                         | **JDK 28**                                                                                                                |
| Zero dependencies (agents, build plugins, locked-down environments) | **JDK 28**                                                                                                                |
| Strict rejection of duplicate or malformed input by default         | **JDK 28**                                                                                                                |
| Mapping whole documents onto DTOs or records                        | Jackson                                                                                                                   |
| Annotations: renames, ignore rules, polymorphic types               | Jackson                                                                                                                   |
| Streaming documents bigger than the heap                            | Jackson's streaming `JsonParser`                                                                                          |
| JSON5, comments, YAML/CBOR/Smile/XML                                | Jackson                                                                                                                   |
| Spring Boot request and response bodies                             | Jackson (Spring Boot 4 uses Jackson 3, see [the Page&lt;T&gt; post](/posts/spring-boot-4-page-deserialization-jackson3/)) |
| A public library API, today                                         | Jackson, until the API leaves incubation                                                                                  |

The JEP is clear that it isn't trying to replace Jackson. It's trying to make
sure a 20-line Java program never needs a `pom.xml` just to read a JSON file.

# FAQ

### Does Java have a built-in JSON parser?

Yes, from Java 28. JEP 540 adds `jdk.incubator.json`, which parses and
generates JSON with no external library. Before Java 28 you needed Jackson,
Gson, Jakarta JSON-P or similar. The old `javax.json` was never part of the JDK.

### Which Java version has the JSON API?

**JDK 28** is the first. It's integrated as an incubator module, scheduled for
GA in March 2027, and early-access builds are available from
[jdk.java.net/28](https://jdk.java.net/28/). Incubator APIs usually go through
at least one more release before being finalized under a permanent package name.

### How do I enable `jdk.incubator.json`?

Pass `--add-modules jdk.incubator.json` to both `javac` and `java`, or add
`requires jdk.incubator.json;` to `module-info.java`. The import is
`import jdk.incubator.json.*;`.

### Is the Java 28 JSON API production ready?

The JEP commits to testing against the
[JSON Parsing Test Suite](https://github.com/nst/JSONTestSuite), and the parser
is strict. The _API_ is what isn't stable. Incubator modules can change or be
removed in later releases. It's fine for internal tools and services you can
update. I'd keep it out of published libraries.

### Does Java 28's JSON API replace Jackson?

No, and that isn't the goal. It has no data binding, no annotations, no
streaming and no other formats. It handles the "read this JSON and grab some
fields" job that used to need a dependency.

### Can it convert JSON to a Java record?

Not by itself. You either map fields by hand or write a small reflective binder
like the one above. If you need that for more than a few types, use Jackson.

### Does it support comments or trailing commas?

No. Only strict RFC 8259 is accepted. Strip comments before parsing if you have to.

### Is `JsonValue` thread safe?

Yes. Every `JsonValue` is immutable and thread safe according to the javadoc,
and `asMap()` and `asList()` return unmodifiable collections.

# Wrapping up

The JDK's JSON API is small, and that's the point. It's one parse method, one
sealed hierarchy, a dozen accessors and some factory methods. It's strict where
JSON is dangerous (duplicate names) and precise where JSON is surprising
(numbers). Sealed types and pattern matching make the tree easy to work with in
a way JEP 198 couldn't have managed in 2014.

What I like most is that a single-file Java program can now do what a Python
script does: fetch some JSON, pull out three fields and print them, with nothing
installed beyond the JDK.

All seven demos, the Jackson comparison and the captured output are in
[DemosAndArticleContent/blog/java-28-json-api](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-28-json-api).
If you're still catching up on JDK releases, [Java 27 Changed Your Defaults](/posts/java-27-new-defaults-benchmark/)
covers what the release before this one changed under you.

## References

- [JEP 540: Simple JSON API (Incubator)](https://openjdk.org/jeps/540)
- [`jdk.incubator.json` javadoc (JDK 28 EA)](https://download.java.net/java/early_access/jdk28/docs/api/jdk.incubator.json/module-summary.html)
- [JEP 198: Light-Weight JSON API](https://openjdk.org/jeps/198) (superseded)
- [RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format](https://www.rfc-editor.org/rfc/rfc8259)
- [JDK 28 early-access builds](https://jdk.java.net/28/)
