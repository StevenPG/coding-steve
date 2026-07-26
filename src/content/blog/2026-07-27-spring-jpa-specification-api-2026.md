---
author: StevenPG
pubDatetime: 2026-07-27T12:00:00.000Z
title: "The Spring Data JPA Specification API in 2026"
slug: spring-jpa-specification-api-2026
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - jpa
  - hibernate
  - postgres
description: A current guide to dynamic database queries with Spring Data JPA — what changed in the 4.x line (PredicateSpecification, unrestricted(), bulk update and delete), a full Criteria API cookbook covering joins, subqueries, inheritance and database functions, and the fetch-join count-query trap that breaks pagination in production.
---

# The Spring Data JPA Specification API in 2026

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Dynamic queries in Spring Data JPA are one of those things, and the material out there is in bad shape: most of it was written against Spring Data JPA 2.x, half of it opens with `Specification.where(null)` — which **does not compile any more** — and almost none of it covers the API that landed in the 4.x line.

So this is not an "ultimate guide." It's a snapshot of how you should be writing dynamic database queries with Spring Data JPA **right now**, in 2026, on the current versions.

Everything below is built against a real companion project:

| Piece               | Version                  |
| ------------------- | ------------------------ |
| Spring Boot         | **4.1.0**                |
| Spring Data JPA     | **4.1.0** (BOM 2026.0.0) |
| Hibernate ORM       | **7.4.1.Final**          |
| Jakarta Persistence | **3.2.0**                |
| Java                | 21                       |
| Gradle              | 9.6                      |
| PostgreSQL          | 18                       |
| Testcontainers      | **2.0.5**                |

If you already use Specifications and just want the delta, skip to [What Changed in the 4.x Line](#what-changed-in-the-4x-line). If you've never used them, start at the top.

## First: No, the Criteria API Is Not Deprecated

This comes up every single time, so let's kill it up front.

There have been **two** things called "the Criteria API" in the Java persistence world, and only one of them died:

- **`org.hibernate.Criteria`** — Hibernate's own, proprietary, pre-JPA criteria API. `session.createCriteria(Flight.class).add(Restrictions.eq("origin", "ATL"))`. This was deprecated in Hibernate 5 and **removed outright in Hibernate 6**. If you remember a criteria API dying, this is the one. It's gone and it's not coming back.
- **`jakarta.persistence.criteria`** — the _standard_ Criteria API, part of the Jakarta Persistence specification. `CriteriaBuilder`, `CriteriaQuery`, `Root`, `Predicate`. This is **alive, current, and actively extended.** It's at version 3.2 in Jakarta Persistence, and Hibernate 7 not only implements it but adds a whole superset on top (`HibernateCriteriaBuilder`).

Spring Data JPA's `Specification` is a thin, composable wrapper over the _second_ one. Every specification you write ultimately produces a `jakarta.persistence.criteria.Predicate`. So when you learn Specifications, you are learning the Criteria API — there's no way to separate them, and there's no deprecation cloud hanging over either.

What people _are_ right about is that the Criteria API is verbose and awkward to write directly. That's exactly the problem Specifications solve.

## What a Specification Actually Is

Strip away the Domain-Driven-Design vocabulary and a `Specification` is a single-method interface that produces one fragment of a `WHERE` clause:

```java
@FunctionalInterface
public interface Specification<T> extends Serializable {
    @Nullable
    Predicate toPredicate(Root<T> root, CriteriaQuery<?> query, CriteriaBuilder builder);
}
```

That's the entire contract. You get:

- **`root`** — the entity you're querying from. This is where you navigate attributes and add joins.
- **`query`** — the query being built. You need it for subqueries, `distinct`, and grouping, and it's how you detect whether you're inside a count query.
- **`builder`** — the factory for every predicate and expression.

You opt in by extending one interface on your repository:

```java
public interface FlightRepository extends JpaRepository<Flight, Long>,
        JpaSpecificationExecutor<Flight> {
}
```

That single addition gives you `findAll(Specification)`, `findAll(Specification, Pageable)`, `count`, `exists`, `update`, `delete`, and the fluent `findBy` — with no implementation on your side.

## The Problem Specifications Solve

Here's the realistic version of the problem. A flight search endpoint with twenty optional filters:

```java
@GetMapping("/search")
public Page<FlightResponse> search(
        @RequestParam(required = false) String origin,
        @RequestParam(required = false) String destination,
        @RequestParam(required = false) Instant departingAfter,
        @RequestParam(required = false) BigDecimal maxPrice,
        @RequestParam(required = false) List<String> airlineCodes,
        @RequestParam(required = false) Alliance alliance,
        @RequestParam(required = false) List<String> requiredAmenities,
        @RequestParam(required = false) CabinClass cabinClass,
        @RequestParam(required = false) Integer minSeatsAvailable,
        // ... eleven more
        ) { ... }
```

Twenty independently-optional filters is **2²⁰ possible WHERE clauses**. Your options:

- **Derived query methods.** You'd need a million of them. `findByOriginAndDestinationAndBasePriceLessThanEqualAndAirlineIataCodeIn...` is already unreadable at four filters, and it can't express "skip this condition when the parameter is null."
- **A single `@Query` with `(:origin is null or f.route.origin = :origin)` repeated twenty times.** This is the pattern I see most in the wild, and it's genuinely awful: the SQL is unreadable, the query planner gets a predicate it can't use an index for, and you still can't express a conditional _join_.
- **String-concatenated JPQL.** Now you own a query compiler, and probably an injection vulnerability.
- **Specifications.** One repository method. Each filter is an independent, testable, reusable object. You fold the ones the caller actually supplied into a single predicate tree.

That last one is the whole pitch, and the fold looks like this:

```java
Specification<Flight> spec = Specification.unrestricted();

if (origin != null)   spec = spec.and(flyingFrom(origin));
if (maxPrice != null) spec = spec.and(priceAtMost(maxPrice));
// ...

return flights.findAll(spec, pageable);
```

## What Changed in the 4.x Line

This is the part no existing tutorial covers, and it contains one change that will break your build the moment you upgrade.

### `Specification.where(null)` is dead — twice over

For a decade, the canonical way to start an accumulator loop was:

```java
Specification<Flight> spec = Specification.where(null);   // "match everything"
```

Null was treated as "this specification contributes nothing," and `and(null)` / `or(null)` silently ignored it. **Spring Data JPA 4.0 removed that null-tolerance entirely.**

Two things now happen. First, it doesn't even compile:

```
error: reference to where is ambiguous
```

4.0 added a `where(PredicateSpecification<T>)` overload alongside `where(Specification<T>)`, so a bare `null` literal is ambiguous between them. Second, once you add the cast the compiler demands, you get a runtime failure instead:

```java
assertThatThrownBy(() -> Specification.where((Specification<Flight>) null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("must not be null");
```

The replacement is explicit:

```java
Specification<Flight> spec = Specification.unrestricted();
```

`unrestricted()` returns a specification whose `toPredicate` returns `null`, which the composition logic elides. `unrestricted().and(other)` is just `other`; `not(unrestricted())` is still `unrestricted()`.

This is a good change — silently ignoring a null you didn't mean to pass is how filters go missing in production — but it is a **compile-breaking** one, and `Specification.where(null)` appears in a truly enormous amount of existing code. Grep for it before you upgrade.

### `PredicateSpecification` — the query-agnostic variant

The interesting new interface is smaller than `Specification`:

```java
public interface PredicateSpecification<T> {
    Predicate toPredicate(From<?, T> from, CriteriaBuilder criteriaBuilder);
}
```

Two differences matter enormously.

**It takes no `CriteriaQuery`.** Most predicates don't need one — they just compare a column to a value. Dropping it means the same fragment can be reused in a `SELECT`, an `UPDATE`, or a `DELETE`, because it isn't bound to a query type.

**It takes a `From`, not a `Root`.** `Root` extends `From`, but so does `Join`. A `PredicateSpecification` can therefore be applied to a root, to a join, or to a correlated subquery alias — the same predicate, pointed at a different alias.

The practical rule: **write `PredicateSpecification` by default, and reach for `Specification` only when you need the query** (subqueries, `distinct`, fetch joins, grouping). They compose with each other in both directions, so mixing them costs nothing:

```java
Specification<Flight> spec = Specification
        .where(flyingFrom("ATL"))              // PredicateSpecification
        .and(hasStatus(FlightStatus.SCHEDULED))// PredicateSpecification
        .and(hasAmenity("WIFI"));              // Specification (uses a subquery)
```

### `UpdateSpecification` and `DeleteSpecification`

Specifications used to be read-only. Not any more:

```java
public interface UpdateSpecification<T> {
    Predicate toPredicate(Root<T> root, CriteriaUpdate<T> update, CriteriaBuilder builder);
}

public interface DeleteSpecification<T> {
    Predicate toPredicate(Root<T> root, CriteriaDelete<T> delete, CriteriaBuilder builder);
}
```

with matching repository methods that return affected row counts:

```java
long update(UpdateSpecification<T> spec);
long delete(DeleteSpecification<T> spec);
```

More on these — including the caveat that will bite you — in [Bulk Update and Delete](#bulk-update-and-delete).

### The full `JpaSpecificationExecutor` surface

Worth having in one place, because it's bigger than most people realise:

```java
Optional<T> findOne(Specification<T> spec);
List<T>     findAll(Specification<T> spec);
List<T>     findAll(Specification<T> spec, Sort sort);
Page<T>     findAll(Specification<T> spec, Pageable pageable);
Page<T>     findAll(Specification<T> spec, Specification<T> countSpec, Pageable pageable);
long        count(Specification<T> spec);
boolean     exists(Specification<T> spec);
long        update(UpdateSpecification<T> spec);
long        delete(DeleteSpecification<T> spec);

<S extends T, R> R findBy(Specification<T> spec,
        Function<? super SpecificationFluentQuery<S>, R> queryFunction);
```

plus `PredicateSpecification` overloads of `findOne`, `findAll`, `count`, `exists`, `delete`, and `findBy`.

That `findAll(spec, countSpec, pageable)` overload is underrated — it lets the page query and the count query differ on purpose, which is one clean way out of the fetch-join trap below.

## Setup, and the Two Dependencies That Trip People Up

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-web")

    // Generates the JPA static metamodel (Flight_, Airline_, ...) at compile time.
    //
    // Note the explicit version: the Spring Boot BOM manages hibernate-core but NOT
    // hibernate-jpamodelgen, so an unversioned entry fails to resolve outright.
    annotationProcessor("org.hibernate.orm:hibernate-jpamodelgen:7.4.1.Final")

    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    // Testcontainers 2.x renamed every module.
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
}
```

Two gotchas in there, both of which cost me time:

1. **`hibernate-jpamodelgen` is not in the Spring Boot BOM.** Leave the version off and Gradle fails with `Could not find org.hibernate.orm:hibernate-jpamodelgen:` (note the empty version). Pin it to whatever Hibernate version Boot brings in — 4.1.0 ships 7.4.1.Final.
2. **Testcontainers 2.x renamed everything.** `org.testcontainers:postgresql` is now `org.testcontainers:testcontainers-postgresql`, `PostgreSQLContainer` moved from `org.testcontainers.containers` to `org.testcontainers.postgresql`, and it dropped the self-referential generic — so it's `new PostgreSQLContainer("postgres:18-alpine")`, not `new PostgreSQLContainer<>(...)`.

## Type Safety: Use the Metamodel

This is the single biggest quality difference between Specification code that ages well and Specification code that doesn't.

The version everyone writes first:

```java
return (root, query, cb) -> cb.equal(root.get("origin"), originCode);
```

`"origin"` is an unchecked string. Rename the field, and this compiles fine and blows up at runtime. Worse, `root.get("origin")` returns `Path<Object>`, so `cb.between(root.get("basePrice"), min, max)` won't even type-check without a cast, and `cb.equal(root.get("basePrice"), "not a number")` compiles happily.

With `hibernate-jpamodelgen` on the annotation processor path, every entity gets a generated companion class:

```java
public abstract class Flight_ {
    public static volatile SingularAttribute<Flight, Long> id;
    public static volatile SingularAttribute<Flight, String> flightNumber;
    public static volatile SingularAttribute<Flight, Route> route;
    public static volatile SingularAttribute<Flight, Instant> departureTime;
    public static volatile SingularAttribute<Flight, BigDecimal> basePrice;
    public static volatile SingularAttribute<Flight, FlightStatus> status;
    public static volatile SingularAttribute<Flight, Airline> airline;
    public static volatile SetAttribute<Flight, Amenity> amenities;
    public static volatile ListAttribute<Flight, Booking> bookings;
    // ...
}
```

and the same predicate becomes:

```java
return (flight, cb) -> cb.equal(flight.get(Flight_.route).get(Route_.origin), originCode);
```

Now a rename is a compile error, `flight.get(Flight_.basePrice)` is a `Path<BigDecimal>`, and your IDE autocompletes attribute names. It generates classes for embeddables (`Route_`) and subclasses (`PassengerFlight_ extends Flight_`) too.

The cost is one `annotationProcessor` line and remembering to run a build before your IDE finds `Flight_`. Take the trade.

Everything from here on uses the metamodel.

## The Domain

The companion project models flight search, deliberately over-mapped so every Criteria shape has somewhere to go:

```java
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "flight_type")
public abstract class Flight {

    @Id @GeneratedValue private Long id;
    private String flightNumber;

    @Embedded private Route route;                       // value type

    private Instant departureTime;
    private BigDecimal basePrice;

    @Enumerated(EnumType.STRING) private FlightStatus status;

    @ManyToOne(fetch = FetchType.LAZY) private Airline airline;
    @ManyToOne(fetch = FetchType.LAZY) private Aircraft aircraft;

    @BatchSize(size = 50)
    @ManyToMany(fetch = FetchType.LAZY) private Set<Amenity> amenities;

    @BatchSize(size = 50)
    @OneToMany(mappedBy = "flight", fetch = FetchType.LAZY) private List<Booking> bookings;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, Object> metadata;                // real PostgreSQL jsonb
}
```

with `PassengerFlight` (adds `seatsAvailable` and an `@ElementCollection Set<CabinClass>`) and `CargoFlight` (adds `maxPayloadKg`) as subclasses.

**Every association is `LAZY`.** That's correct, and it's what makes the fetch-join section further down worth reading.

## The Cookbook

### Column predicates

The bread and butter. Note these are all `PredicateSpecification` — no `CriteriaQuery` needed:

```java
public static PredicateSpecification<Flight> hasStatus(FlightStatus status) {
    return (flight, cb) -> cb.equal(flight.get(Flight_.status), status);
}

public static PredicateSpecification<Flight> statusIn(Collection<FlightStatus> statuses) {
    return (flight, cb) -> flight.get(Flight_.status).in(statuses);
}

public static PredicateSpecification<Flight> priceBetween(BigDecimal min, BigDecimal max) {
    return (flight, cb) -> cb.between(flight.get(Flight_.basePrice), min, max);
}

public static PredicateSpecification<Flight> departsAfter(Instant threshold) {
    return (flight, cb) -> cb.greaterThan(flight.get(Flight_.departureTime), threshold);
}
```

Notice what these methods _don't_ do: none of them return `null` when the argument is null. **Null-handling belongs in the caller**, exactly once, not scattered across forty specification factories. More on that in [Composing the Search](#composing-the-search).

### Embeddables

An `@Embedded` value type is two `get()` calls, and the metamodel covers it:

```java
public static PredicateSpecification<Flight> flyingFrom(String originCode) {
    return (flight, cb) -> cb.equal(flight.get(Flight_.route).get(Route_.origin), originCode);
}
```

### Joins

For a `@ManyToOne`, just navigate the path — Hibernate emits the inner join for you:

```java
public static PredicateSpecification<Flight> operatedBy(String airlineIataCode) {
    return (flight, cb) -> cb.equal(
            flight.get(Flight_.airline).get(Airline_.iataCode), airlineIataCode);
}
```

Use an explicit `join()` when several predicates should share one alias:

```java
public static PredicateSpecification<Flight> inAlliance(Alliance alliance) {
    return (flight, cb) -> {
        Join<Flight, Airline> airline = flight.join(Flight_.airline, JoinType.INNER);
        return cb.equal(airline.get(Airline_.alliance), alliance);
    };
}
```

To-one joins are safe to repeat. To-many joins are not, which brings us to the most common bug in this whole area.

### Collections: use `EXISTS`, not a join

"Find flights that have wifi" looks like a join:

```java
SetJoin<Flight, Amenity> amenity = root.join(Flight_.amenities, JoinType.INNER);
query.distinct(true);
return cb.equal(amenity.get(Amenity_.code), "WIFI");
```

This works, but it **multiplies rows** — one per matching amenity — and only produces the right answer because of that `distinct(true)`. Forget the distinct and your page of 20 silently contains 12 distinct flights. You also pay for a distinct over the entire join on every query, including the count.

The `EXISTS` form has none of those properties:

```java
public static Specification<Flight> hasAmenity(String amenityCode) {
    return (root, query, cb) -> {
        Subquery<Long> sub = query.subquery(Long.class);
        Root<Flight> correlated = sub.correlate(root);
        SetJoin<Flight, Amenity> amenity = correlated.join(Flight_.amenities);
        sub.select(cb.literal(1L));
        sub.where(cb.equal(amenity.get(Amenity_.code), amenityCode));
        return cb.exists(sub);
    };
}
```

One row per flight, no distinct, no broken pagination, and the database can short-circuit on the first match.

And here's the bug the join form encourages. "Has **all** of these amenities" is _not_ `amenity.code IN ('WIFI','POWER')` — that matches a flight with only one of them. You need to count:

```java
public static Specification<Flight> hasAllAmenities(Collection<String> amenityCodes) {
    return (root, query, cb) -> {
        Subquery<Long> sub = query.subquery(Long.class);
        Root<Flight> correlated = sub.correlate(root);
        SetJoin<Flight, Amenity> amenity = correlated.join(Flight_.amenities);
        sub.select(cb.countDistinct(amenity.get(Amenity_.code)));
        sub.where(amenity.get(Amenity_.code).in(amenityCodes));
        return cb.equal(sub, (long) amenityCodes.size());
    };
}
```

In the demo dataset, 80 flights have wifi and 40 have both wifi _and_ power. The `IN` version reports 120.

### Subqueries

**Uncorrelated** — a fresh root inside the subquery, joined back manually:

```java
public static Specification<Flight> hasAtLeastBookings(long minBookings) {
    return (root, query, cb) -> {
        Subquery<Long> sub = query.subquery(Long.class);
        Root<Booking> booking = sub.from(Booking.class);
        sub.select(cb.count(booking));
        sub.where(cb.equal(booking.get(Booking_.flight), root));
        return cb.ge(sub, minBookings);
    };
}
```

**Correlated** — `sub.correlate(root)` reuses the outer alias, so you can navigate associations from it:

```java
public static Specification<Flight> averageFareAbove(double minAverageFare) {
    return (root, query, cb) -> {
        Subquery<Double> sub = query.subquery(Double.class);
        Root<Flight> correlated = sub.correlate(root);
        ListJoin<Flight, Booking> booking = correlated.join(Flight_.bookings);
        sub.select(cb.avg(booking.get(Booking_.farePaid)));
        return cb.greaterThan(sub, minAverageFare);
    };
}
```

**`NOT EXISTS`** — far clearer than a left join plus an is-null check:

```java
public static Specification<Flight> hasNoBookings() {
    return (root, query, cb) -> {
        Subquery<Long> sub = query.subquery(Long.class);
        Root<Booking> booking = sub.from(Booking.class);
        sub.select(cb.literal(1L));
        sub.where(cb.equal(booking.get(Booking_.flight), root));
        return cb.not(cb.exists(sub));
    };
}
```

### Inheritance: `type()` and `treat()`

Filtering by concrete type maps straight to the discriminator column — no downcast needed:

```java
public static PredicateSpecification<Flight> isPassengerFlight() {
    return (flight, cb) -> cb.equal(flight.type(), cb.literal(PassengerFlight.class));
}
```

Reaching a _subclass attribute_ from a `Root<Flight>` needs `treat()`:

```java
public static Specification<Flight> withSeatsAvailable(int minSeats) {
    return (root, query, cb) -> {
        Root<PassengerFlight> passenger = cb.treat(root, PassengerFlight.class);
        return cb.ge(passenger.get(PassengerFlight_.seatsAvailable), minSeats);
    };
}
```

**The trap:** `treat()` narrows the _path_, not the _result set_. On its own it does not filter out cargo flights — it just lets you talk about a column they don't have. Always pair it with the type check:

```java
Specification<Flight> spec = Specification
        .where(isPassengerFlight())
        .and(withSeatsAvailable(40));
```

`isMember` works against an `@ElementCollection` the same way:

```java
public static Specification<Flight> offersCabinClass(CabinClass cabinClass) {
    return (root, query, cb) -> {
        Root<PassengerFlight> passenger = cb.treat(root, PassengerFlight.class);
        return cb.isMember(cabinClass, passenger.get(PassengerFlight_.cabinClasses));
    };
}
```

### Database functions

`cb.function()` is the escape hatch for anything JPA never standardised. It takes a function name, a return type, and expressions — and it composes like any other predicate.

"Morning departures," via PostgreSQL's `date_part`:

```java
public static PredicateSpecification<Flight> departsBetweenHours(int fromHour, int toHour) {
    return (flight, cb) -> {
        Expression<Double> hour = cb.function(
                "date_part", Double.class,
                cb.literal("hour"),
                flight.get(Flight_.departureTime));
        return cb.between(hour, (double) fromHour, (double) toHour);
    };
}
```

Reading a key out of a `jsonb` column:

```java
public static PredicateSpecification<Flight> metadataStringEquals(String key, String value) {
    return (flight, cb) -> {
        Expression<String> extracted = cb.function(
                "jsonb_extract_path_text", String.class,
                flight.get(Flight_.metadata),
                cb.literal(key));
        return cb.equal(extracted, value);
    };
}
```

That second one is worth sitting with: a JSON containment filter, composed into the same predicate tree as your ordinary column filters, with no native query and no `@Query` string.

### Hibernate 7's builder extensions

The `CriteriaBuilder` you're handed is always a `HibernateCriteriaBuilder`, which is a superset of the JPA interface. The cast is safe on Hibernate, and it buys you things the spec never defined:

```java
public static PredicateSpecification<Flight> flightNumberMatches(String pattern) {
    return (flight, cb) -> {
        HibernateCriteriaBuilder hcb = (HibernateCriteriaBuilder) cb;
        return hcb.ilike(flight.get(Flight_.flightNumber), pattern);
    };
}
```

versus the portable version, which you'd write if you might ever run on a different provider:

```java
return (flight, cb) -> cb.like(
        cb.lower(flight.get(Flight_.flightNumber)),
        pattern.toLowerCase());
```

`HibernateCriteriaBuilder` also carries `notIlike`, array and collection operations, richer temporal handling, and more. It's the least-known useful thing in this whole post.

## Composing the Search

Here's where it all comes together. The search form is a record where every component is optional:

```java
public record FlightSearchCriteria(
        String origin,
        String destination,
        Instant departingAfter,
        BigDecimal maxPrice,
        List<String> airlineCodes,
        Alliance alliance,
        List<String> requiredAmenities,
        CabinClass cabinClass,
        Integer minSeatsAvailable,
        // ... twenty in total
        ) {}
```

and the builder folds it into one specification:

```java
public static Specification<Flight> from(FlightSearchCriteria criteria) {

    Specification<Flight> spec = Specification.unrestricted();

    spec = and(spec, criteria.origin(),        FlightSpecifications::flyingFrom);
    spec = and(spec, criteria.destination(),   FlightSpecifications::flyingTo);
    spec = and(spec, criteria.maxPrice(),      FlightSpecifications::priceAtMost);
    spec = and(spec, criteria.alliance(),      FlightSpecifications::inAlliance);
    spec = and(spec, criteria.maxDistanceKm(), FlightSpecifications::shorterThan);

    if (isNotEmpty(criteria.requiredAmenities())) {
        spec = spec.and(hasAllAmenities(criteria.requiredAmenities()));
    }

    // treat() narrows the path, not the result set — so guard with the discriminator.
    if (criteria.cabinClass() != null) {
        spec = spec.and(isPassengerFlight()).and(offersCabinClass(criteria.cabinClass()));
    }

    return spec;
}

private static <V> Specification<Flight> and(
        Specification<Flight> spec, V value,
        Function<V, PredicateSpecification<Flight>> factory) {
    return value == null ? spec : spec.and(factory.apply(value));
}
```

That little `and` helper is the whole trick. **Null-checking happens once, in one place**, which is what lets every specification factory assume its arguments are real. Before 4.0 people leaned on null-tolerant composition to achieve the same thing implicitly; now that it throws, doing it explicitly is both required and better.

For a runtime-sized list of alternatives, `allOf` / `anyOf` fold without a loop:

```java
long matching = flights.count(PredicateSpecification.allOf(filters));
```

## Fetch Joins, N+1, and the Count-Query Trap

This is the section that will save you a production incident.

Every association on `Flight` is lazy. So `findAll(spec, pageable).map(FlightResponse::from)` — which touches `flight.getAirline()` on each row — issues one extra query per flight. Classic N+1.

The obvious fix is a fetch join inside a specification. **The obvious fix is also broken:**

```java
public static Specification<Flight> fetchAirlineUnguarded() {
    return (root, query, cb) -> {
        root.fetch(Flight_.airline, JoinType.LEFT);
        return null;
    };
}
```

Pass that to `findAll(spec, pageable)` and you get:

```
query specified join fetching, but the owner of the fetched association
was not present in the select list
```

**Why:** `findAll(spec, pageable)` runs your specification **twice** — once for the page, and once for the derived `select count(f) from Flight f`. A join fetch in a count query is invalid, because there's no entity in the select list to attach the fetched association to.

The fix is to detect the count query and skip the fetch:

```java
public static Specification<Flight> fetchAirlineAndAircraft() {
    return (root, query, cb) -> {
        if (query != null
                && Long.class != query.getResultType()
                && long.class != query.getResultType()) {
            root.fetch(Flight_.airline, JoinType.LEFT);
            root.fetch(Flight_.aircraft, JoinType.LEFT);
        }
        return null;   // contributes no restriction
    };
}
```

Returning `null` from `toPredicate` is exactly what `unrestricted()` does — this specification adds a fetch and no filtering.

**Three better options, in the order I'd reach for them:**

1. **`@EntityGraph` on a derived query.** Spring Data applies the graph to the page query only and leaves the count query alone. Use this whenever the graph you need is static.
2. **`findAll(spec, countSpec, pageable)`** — pass the fetch-joining spec for the page and a plain one for the count. Explicit, and no reflection on result types.
3. **`@BatchSize` for to-many associations.** You genuinely _cannot_ fetch-join a to-many alongside pagination — Hibernate would have to paginate in memory, and it will warn you about exactly that. `@BatchSize(size = 50)` turns N+1 into N/50+1 by loading the collections for fifty flights in one `IN` query. That's why it's on `Flight.amenities` in the demo.

The rule of thumb: **fetch-join to-ones, batch-size to-manys, and never fetch anything inside a count query.**

## Pagination and Projections: the Fluent `findBy`

`findBy(spec, queryFunction)` is the most capable and least-known method on the interface. The chainable part: `sortBy`, `limit`, `as`, `project`. The terminal part: `first`, `one`, `all`, `page`, `slice`, `scroll`, `stream`, `count`, `exists`.

**DTO projections.** Instead of hydrating entities, narrow the SELECT list to a record:

```java
public record FlightSummary(Long id, String flightNumber, Instant departureTime,
                            Instant arrivalTime, BigDecimal basePrice, FlightStatus status) {}

Page<FlightSummary> page = flights.findBy(spec, query -> query
        .as(FlightSummary.class)
        .page(PageRequest.of(0, 20, Sort.by("departureTime"))));
```

No lazy associations, no persistence-context bookkeeping, no possible N+1. The record's component names must match property names on the entity, which is why this one is flat rather than nesting the embedded route.

**"The cheapest one" without a `Pageable`:**

```java
Optional<Flight> cheapest = flights.findBy(spec, query -> query
        .sortBy(Sort.by("basePrice").ascending().and(Sort.by("id").ascending()))
        .first());
```

**Keyset scrolling.** `OFFSET 200000` makes the database walk and discard 200,000 rows. A keyset scroll turns the same page into an index seek:

```java
Window<FlightSummary> window = flights.findBy(spec, query -> query
        .as(FlightSummary.class)
        .sortBy(Sort.by("departureTime").ascending().and(Sort.by("id").ascending()))
        .limit(20)
        .scroll(ScrollPosition.keyset()));

ScrollPosition next = window.positionAt(window.getContent().size() - 1);
```

Two rules: **the sort must end in a unique column** (hence the `id` tie-breaker — without it the cursor is ambiguous and you'll skip or repeat rows), and you carry the cursor forward rather than an offset. Rebuilding it from request parameters looks like:

```java
Map<String, Object> keys = new LinkedHashMap<>();
keys.put("departureTime", afterDeparture);
keys.put("id", afterId);
return ScrollPosition.of(keys, KeysetScrollPosition.Direction.FORWARD);
```

Keyset pagination is the right default for infinite-scroll UIs and for any export that walks a large table. Offset pagination is fine for a page-numbered UI where nobody goes past page 20.

## Bulk Update and Delete

`UpdateSpecification` composes an update statement out of a "what to set" part and a "where" part:

```java
public static UpdateSpecification<Flight> cancelFlights(PredicateSpecification<Flight> where) {
    return UpdateSpecification.<Flight>update(
                    (root, update, cb) -> update.set(Flight_.status, FlightStatus.CANCELLED))
            .where(where);
}

long cancelled = flights.update(cancelFlights(
        flyingFrom("ATL").and(hasStatus(FlightStatus.SCHEDULED))));
```

The `set` value can be an expression over the row itself:

```java
UpdateSpecification.<Flight>update((root, update, cb) ->
                update.set(Flight_.basePrice, cb.prod(root.get(Flight_.basePrice), multiplier)))
        .where(where);
```

Delete is the same shape, and takes a plain `PredicateSpecification` for the where clause:

```java
long deleted = flights.delete(DeleteSpecification.where(hasStatus(FlightStatus.CANCELLED)));
```

This is a genuine improvement over load-all-then-`saveAll`: one statement, no entity hydration, no dirty-checking pass over ten thousand objects.

**The caveat, and it is a sharp one:** bulk operations go straight to the database and **do not synchronise the persistence context**. An entity you already loaded in the same transaction keeps its stale state:

```java
Flight loaded = flights.findAll(target).get(0);
assertThat(loaded.getStatus()).isEqualTo(FlightStatus.SCHEDULED);

flights.update(cancelFlights(target));

// Still SCHEDULED in memory — the UPDATE went straight to the database.
assertThat(loaded.getStatus()).isEqualTo(FlightStatus.SCHEDULED);

entityManager.flush();
entityManager.clear();

// Only now does a reload see the truth.
assertThat(flights.findById(loaded.getId()).orElseThrow().getStatus())
        .isEqualTo(FlightStatus.CANCELLED);
```

Worse, if that stale entity is still managed and something dirties it, the flush at commit can **write the old value back over your bulk update**. Rule: do bulk writes early in a transaction, before loading the affected entities, or clear the persistence context afterwards.

Also remember bulk deletes bypass cascade and orphan-removal — the database's foreign keys are the only thing protecting you. In the demo, bookings have to go before the flights they point at.

## Where Specifications Fight You

Honesty section. Specifications express **predicates**. They are a poor fit for anything that changes the _shape_ of the query.

`GROUP BY` / `HAVING` is the clearest example. You can do it:

```java
public static Specification<Flight> groupedBookingCountAtLeast(long minBookings) {
    return (root, query, cb) -> {
        ListJoin<Flight, Booking> booking = root.join(Flight_.bookings, JoinType.LEFT);
        query.groupBy(root.get(Flight_.id));
        query.having(cb.ge(cb.count(booking.get(Booking_.id)), minBookings));
        return null;
    };
}
```

but this only works on PostgreSQL — grouping by the primary key makes the other selected columns functionally dependent, which most other databases won't accept — and it quietly corrupts the derived count query. Express the same restriction as a subquery instead and the query shape stays untouched:

```java
flights.findAll(hasAtLeastBookings(4));   // the version you should ship
```

Other places to reach for something else:

- **Aggregate result sets** ("revenue per airline per month"). That's a projection query, not a filter. Use `@Query` with a DTO constructor expression, or drop to SQL.
- **Recursive CTEs, window functions, `LATERAL` joins.** Native query territory.
- **Genuinely dynamic sorting over joined columns.** Doable, but `Sort` plus a `Pageable` covers most of it more simply.
- **Very complex reporting.** If your specification tree needs a diagram, you want jOOQ or a view.

## The 2026 Alternatives, Honestly

| Approach             | Best at                                                                            | Watch out for                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Derived queries**  | 1–3 fixed filters. Zero ceremony.                                                  | Method names explode combinatorially; can't express optional filters.                                                                                                                        |
| **`@Query` (JPQL)**  | One fixed, complex query you'll read often.                                        | The `:x is null or col = :x` pattern is unreadable and unindexable at scale.                                                                                                                 |
| **Specifications**   | **Many optional filters, composed at runtime.** Reusable, unit-testable fragments. | Verbose; poor fit for changing query shape; the fetch-join/count trap.                                                                                                                       |
| **Query by Example** | Trivial "match these populated fields" cases.                                      | Equality only. No ranges, no OR, no joins. Runs out of road immediately.                                                                                                                     |
| **QueryDSL**         | The nicest type-safe DSL of the lot, if you already use it.                        | Maintenance has been intermittent for years and keeping the codegen aligned with new Java/Jakarta releases has repeatedly been the pain point. I wouldn't start a new project on it in 2026. |
| **jOOQ**             | SQL-first work: reporting, window functions, CTEs, bulk.                           | Not an ORM; separate codegen; commercial licence for non-open-source databases.                                                                                                              |
| **Native SQL**       | The 2% JPQL genuinely can't express.                                               | You own mapping and portability.                                                                                                                                                             |

My actual advice: **derived queries until it hurts, Specifications the moment filters become optional, jOOQ or native SQL when you're writing reports rather than queries.** These coexist happily in one codebase — a repository can extend `JpaSpecificationExecutor` and still carry `@Query` methods.

## Testing With Testcontainers 2.0

Half of what's above doesn't exist on an in-memory database — `jsonb`, `date_part`, `ilike`, and the exact count-query failure all need real PostgreSQL. So the suite runs against one:

```java
@SpringBootTest
@Testcontainers
@Transactional
public abstract class AbstractPostgresTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine");

    @PersistenceContext protected EntityManager entityManager;
    @Autowired protected FlightRepository flights;

    @BeforeEach
    void seed() {
        SampleData.load(entityManager);
    }
}
```

`@ServiceConnection` wires the JDBC URL, username, and password into the context with no `@DynamicPropertySource` boilerplate. The `static` container starts once and is reused across every test class. Class-level `@Transactional` rolls each test back, so they can't see each other's writes.

The one thing to remember for bulk-operation tests: `flush()` then `clear()` before asserting, or you're reading the stale persistence context rather than the database.

If you want more on this setup, I went deeper in [the Testcontainers guide](/posts/ultimate-guide-testcontainers-spring-boot/).

## The Gotcha Checklist

Everything that cost me time, in one list:

1. **`Specification.where(null)` no longer compiles** (ambiguous overload) and throws once cast. Use `Specification.unrestricted()`.
2. **`and(null)` / `or(null)` throw too.** Do null-checking once in the caller.
3. **`hibernate-jpamodelgen` needs an explicit version** — it isn't in the Spring Boot BOM.
4. **Testcontainers 2.x renamed every module** and moved `PostgreSQLContainer` to `org.testcontainers.postgresql`.
5. **A fetch join in a paginated query needs a `getResultType()` guard**, or use `@EntityGraph` / the `countSpec` overload.
6. **You cannot fetch-join a to-many with pagination.** Use `@BatchSize`.
7. **`treat()` narrows the path, not the result set.** Pair it with a `type()` check.
8. **A to-many join without `distinct` multiplies rows.** Prefer `EXISTS`.
9. **"Has all of these" is a counting subquery**, never an `IN` list.
10. **Bulk update/delete don't refresh the persistence context** — and a stale managed entity can overwrite your update at flush time.
11. **Keyset scrolling needs a unique tie-breaker column** in the sort.
12. **Write `PredicateSpecification` by default**; reach for `Specification` only when you need the `CriteriaQuery`.

## Wrapping Up

The Specification API in 2026 is in the best shape it's ever been. `PredicateSpecification` removed the ceremony from the 90% case and made fragments reusable across selects, updates, and deletes. `UpdateSpecification` and `DeleteSpecification` closed the read-only gap. The fluent `findBy` brought projections, limits, and keyset scrolling to the same composable filters. And killing null-tolerance, breaking change though it is, turned a whole category of silently-dropped filters into compile errors.

What hasn't changed is the core judgement call. Specifications are for **predicates that vary at runtime**. When your filters are fixed, a derived query is shorter and clearer. When you're changing the shape of the query rather than its restrictions, you want JPQL, jOOQ, or SQL. When you have twenty optional filters and one endpoint — which is most search features anyone actually ships — nothing else in the JPA ecosystem comes close.

The companion project used throughout this post is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-jpa-specifications-2026). It has the full cookbook, the twenty-filter search endpoint, a seeded 120-flight dataset so every number above is reproducible, `scripts/demo-requests.sh` to watch filters compose one at a time, and a Testcontainers suite covering each capability.

If this was useful, the [Testcontainers guide](/posts/ultimate-guide-testcontainers-spring-boot/), the [Flyway vs Liquibase comparison](/posts/flyway-vs-liquibase-2026/), and the [UUIDv7 in Spring Boot and Postgres](/posts/uuidv7-in-spring-boot-and-postgres/) post cover the neighbouring pieces of a JPA stack.
