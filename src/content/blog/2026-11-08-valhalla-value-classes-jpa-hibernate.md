---
author: StevenPG
pubDatetime: 2026-11-08T12:00:00.000Z
title: "Do Java Valhalla Value Classes Make JPA and Hibernate Faster? (JDK 28 EA, Tested)"
slug: valhalla-value-classes-jpa-hibernate
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - java
  - spring boot
  - jpa
  - performance
description: "Can you use Java 28 value classes (JEP 401) as JPA embeddables, IDs and converters in Hibernate 7 and Spring Data JPA? Tested on JDK 28 EA with Postgres: what works, what breaks, and whether it's any faster."
---

## Table of Contents

[[toc]]

# Value classes meet your entity model

In the main Valhalla post,
[Java Value Classes Benchmarked: Project Valhalla (JEP 401) on JDK 28 Early Access](/posts/java-28-valhalla-value-classes-benchmark/),
I covered what JDK 28's value classes
([JEP 401](https://openjdk.org/jeps/401)) do to plain Java code. This post asks
what most Spring Boot developers will want to know next:
**can I put value classes in my JPA entities, and does Hibernate get any faster?**

The short answer, tested on JDK 28 early-access build 23 with Hibernate
7.4.13.Final, Spring Boot 4.1.2 and PostgreSQL 18:

- **Works:** value records as `@Embeddable` types, as an `@EmbeddedId`, as an
  `@IdClass`, and behind an `AttributeConverter`. This includes Spring Data
  repositories, derived queries, dirty checking and lazy proxies on the entity
  that holds them.
- **Works with one annotation:** a non-record value class as an embeddable, as
  long as you give Hibernate a constructor to call with `@Instantiator`.
- **Breaks:** a value class as an `@Entity`, and a value class embeddable written
  the classic JPA way with a no-arg constructor. Both fail with
  `IllegalAccessException: Can not set final ... field`.
- **Faster?** Not measurably. Loading 200,000 rows took the same time either
  way, and value records allocated slightly _more_ (16 bytes per row) during the
  load. Once the rows are loaded, they hold about 16 bytes less per row, because
  the JVM flattened one of the embeddables into the entity.

Everything below comes from a Spring Boot + Testcontainers project I ran on an
Apple M3 Pro on November 8, 2026. Error messages are copied from the test
output. The code, along with the raw benchmark output, is at
[DemosAndArticleContent/blog/valhalla-value-classes-jpa-hibernate](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/valhalla-value-classes-jpa-hibernate).

# Why this might matter for JPA

A typical JPA domain model is full of small, immutable objects that represent a
value rather than a thing with its own lifecycle: `Money`, `Address`,
`OrderId`, `Sku`, `Quantity`. JPA already treats these differently from
entities. An `@Embeddable` has no identity of its own in the database. It's just
some columns on the owning row.

In Java, though, each of those is still a heap object with an object header,
its own identity, and a pointer from the entity to it. Value classes remove
the identity part. A value class has no identity, so `==` compares state, and
the JVM is free to flatten it into whatever holds it. So it's fair to ask
whether embeddables should be value classes, and whether that makes loading
and holding entities cheaper.

# The setup

You need a JDK 28 early-access build from [jdk.java.net/28](https://jdk.java.net/28/).
Value classes are a preview feature, so both compiling and running need
`--enable-preview`. In Gradle:

```kotlin
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(28)
    }
}

tasks.withType<JavaCompile> {
    options.compilerArgs.add("--enable-preview")
}

tasks.withType<Test> {
    jvmArgs("--enable-preview")
}
```

Gradle can't auto-download EA builds, so point it at your install:

```bash
./gradlew test -Porg.gradle.java.installations.paths=/path/to/jdk-28.jdk/Contents/Home
```

Everything else is a normal Spring Boot 4.1.2 app with
`spring-boot-starter-data-jpa`, the Postgres driver, and Testcontainers 2.0.5
running `postgres:18`. Nothing about Spring Boot or Hibernate needed changing to
start the app on JDK 28 with preview features on. Component scanning, entity
scanning and Hibernate's ByteBuddy-based proxies all handled the preview class
files without complaint.

# What works

## Value records as embeddables

This is the case you'll most likely want, and it just works:

```java
@Embeddable
public value record Money(long amountCents, String currency) {}
```

```java
@Entity
public class PurchaseOrder {
    @EmbeddedId
    @AttributeOverride(name = "value", column = @Column(name = "id"))
    private OrderId id;

    private Money total;

    private Sku sku;

    @ManyToOne(fetch = FetchType.LAZY)
    private Customer customer;

    // constructors, getters, setTotal(...)
}
```

Hibernate has supported records as embeddables since 6.2. It builds them
through the canonical constructor and never tries to set a field afterward.
That's exactly what a value record needs, so adding the `value` keyword changes
nothing on Hibernate's side.

## A value record as the primary key

Strongly typed IDs are a natural fit for value classes:

```java
@Embeddable
public value record OrderId(UUID value) {
    public static OrderId random() {
        return new OrderId(UUID.randomUUID());
    }
}

public interface PurchaseOrderRepository extends JpaRepository<PurchaseOrder, OrderId> {
    List<PurchaseOrder> findBySku(Sku sku);
    List<PurchaseOrder> findByTotal(Money total);
}
```

`save`, `findById`, and both derived queries passed. A value record also worked
as an `@IdClass` for a two-column composite key, including `find` by a freshly
constructed key.

## A value record behind an AttributeConverter

For single-column wrappers, a converter is the simplest mapping. It's just two
method calls, so Hibernate never touches the value class's fields:

```java
public value record Sku(String code) {}

@Converter(autoApply = true)
public class SkuConverter implements AttributeConverter<Sku, String> {
    public String convertToDatabaseColumn(Sku sku) {
        return sku == null ? null : sku.code();
    }

    public Sku convertToEntityAttribute(String code) {
        return code == null ? null : new Sku(code);
    }
}
```

## The things I expected to break, and didn't

Identity-sensitive operations, proxies and reflection seemed like the likely
trouble spots, so the test suite targets each one. All of these passed:

| Test                                                                      | Result |
| ------------------------------------------------------------------------- | ------ |
| Round trip of `@EmbeddedId`, `@Embeddable` and converter                  | Passes |
| Derived queries binding a value record as a parameter                     | Passes |
| Dirty checking after replacing a value embeddable with a new one          | Passes |
| Two `em.find` calls with different-but-equal `OrderId`s return one entity | Passes |
| Lazy `@ManyToOne` on an entity with value-class fields                    | Passes |

The lazy association came back as `com.example.valhallajpa.Customer$HibernateProxy`,
uninitialized, and initialized normally when touched. The proxy is a subclass
of the _entity_, and entities are still ordinary identity classes, so nothing
changes there.

Dirty checking works because Hibernate compares embeddable state with
`equals`, not `==`. And since value objects are immutable, there's no way to
change one in place. You replace it, which is what Hibernate's dirty checking
handles best:

```java
tx.executeWithoutResult(s ->
        em.find(PurchaseOrder.class, id).setTotal(new Money(250, "USD")));
```

# What breaks

## A value class as an @Entity

```java
@Entity
public value class ValuePointEntity {
    @Id
    private final Long id;
    private final int x;
    private final int y;

    protected ValuePointEntity() { this.id = null; this.x = 0; this.y = 0; }
    public ValuePointEntity(Long id, int x, int y) { /* ... */ }
}
```

Hibernate accepted the mapping and `persist` plus commit succeeded. Loading it
back failed:

```text
org.hibernate.PropertyAccessException: Could not set value of type [java.lang.Long]:
    'com.example.broken.ValuePointEntity.id' (setter)
root cause: java.lang.IllegalAccessException: Can not set final java.lang.Long field
    com.example.broken.ValuePointEntity.id to java.lang.Long
```

The stack trace shows where it happens. On load, Hibernate calls the no-arg
constructor (`AbstractEntityPersister.instantiate`) and then sets the ID
reflectively (`setIdentifier`). A value class's fields are final and can only
be set in its constructor, and reflection won't override that.

You don't want this mapping anyway. An entity is a managed object that changes
over time and is compared by identity in the persistence context, which is
the opposite of a value. A concrete value class is also implicitly final, so
Hibernate couldn't make a lazy proxy subclass of it either. Keep entities as
identity classes.

## A value class embeddable with a no-arg constructor

This one is more likely to catch people out, because it's how many teams write
embeddables today:

```java
@Embeddable
public value class Dimensions {
    private int widthMm;
    private int heightMm;

    protected Dimensions() { this.widthMm = 0; this.heightMm = 0; }
    public Dimensions(int widthMm, int heightMm) { /* ... */ }
}
```

The fields aren't declared `final`, but in a value class they are anyway, and
the compiler doesn't warn you. This one fails sooner: during `persist`, before
anything reaches the database.

```text
org.hibernate.InstantiationException: Could not instantiate entity 'com.example.broken.Dimensions'
    due to: Could not set value of type [java.lang.Integer]:
    'com.example.broken.Dimensions.heightMm' (setter)
root cause: java.lang.IllegalAccessException: Can not set final int field
    com.example.broken.Dimensions.heightMm to java.lang.Integer
```

The trace runs through `ComponentType.deepCopy`. While saving, Hibernate copies
the embeddable's state into a new instance, the same no-arg-then-set-fields
way, and fails there.

**The fix is Hibernate's `@Instantiator`.** Remove the no-arg constructor and
tell Hibernate which constructor to call and how its parameters map to
attributes:

```java
@Embeddable
public value class DimensionsWithInstantiator {
    private int widthMm;
    private int heightMm;

    @Instantiator({"widthMm", "heightMm"})
    public DimensionsWithInstantiator(int widthMm, int heightMm) {
        this.widthMm = widthMm;
        this.heightMm = heightMm;
    }
    // accessors
}
```

That version persisted and loaded correctly. Or skip the annotation and make
it a `value record`, which gets the same constructor-based handling
automatically.

# The == trap in tests

One of my own assertions failed on the first run, and it's worth knowing
about. I assumed two `OrderId`s holding equal UUIDs would be `==`, because value
classes compare by state:

```java
OrderId lookup = new OrderId(UUID.fromString(id.value().toString()));
assertThat(lookup == id).isTrue(); // FAILED
```

`==` on a value object compares its fields, and for reference fields it
compares them with `==` too. `java.util.UUID` and `String` are still
**identity** classes in this build (`UUID.class.isValue()` and
`String.class.isValue()` both return `false`). So an `OrderId` wrapping a
different-but-equal `UUID` instance isn't `==` to the original. The same goes
for `Money`. A loaded `Money(1999, "USD")` isn't `==` to
`new Money(1999, "USD")`, because the currency string came back from JDBC as a
new `String`.

None of this affects Hibernate or Spring Data, which use `equals`. `findById`
with the "non-`==`" key worked fine. It only matters if your own code starts
replacing `equals` with `==` because "it's a value class now". Keep using
`equals`.

The flip side: with `--enable-preview` on, the JDK's box classes become value
classes. `Long.class.isValue()` is `true`. That covers your `@Id Long` fields,
and every test here still passed with them.

# Is it faster?

## What the JVM actually does with the fields

Before benchmarking, I checked whether the JVM actually flattens anything. The
benchmark uses two entities with identical columns. `ValueLine` holds a
`Money` and a `Quantity` that are value records, and `IdentityLine` holds
plain-record versions of the same two. `-XX:+PrintFieldLayout` (a diagnostic
flag) shows the difference:

```text
Layout of class com/example/valhallajpa/ValueLine
 @8 FLAT 8/8 "qty" Lcom/example/valhallajpa/Quantity; ... NULLABLE_ATOMIC_FLAT
 @16 REGULAR 4/4 "id" Ljava/lang/Long;
 @20 REGULAR 4/4 "price" Lcom/example/valhallajpa/Money;
Instance size = 24 bytes

Layout of class com/example/valhallajpa/IdentityLine
 @8 REGULAR 4/4 "id" Ljava/lang/Long;
 @12 REGULAR 4/4 "price" Lcom/example/valhallajpa/IdentityMoney;
 @16 REGULAR 4/4 "qty" Lcom/example/valhallajpa/IdentityQuantity;
Instance size = 24 bytes
```

`Quantity` (a single `int`) was flattened straight into the entity. `Money` (a
`long` and a `String`) was not. With its null marker it doesn't fit the 64-bit
atomic flat layout this build uses for nullable fields, so it stays a pointer
to a separate heap object, the same as before.

Both entity objects are 24 bytes. The difference is what hangs off them. Adding
up the instance sizes the JVM printed, each `IdentityLine` keeps a 16-byte
`IdentityQuantity` alive and `ValueLine` doesn't. That's **16 bytes less per
loaded row** (64 versus 48 bytes for the entity and its two embeddables, not
counting the shared `Long` and `String`). I worked this out from the printed
layouts rather than measuring the heap.

## The benchmark

Both tables were seeded with the same 200,000 rows. Each round loads the whole
table through the `EntityManager` (read-only), touches every entity, and
records wall time and bytes allocated on the loading thread. That's 10 warm-up
rounds and 20 measured rounds, alternating which mapping goes first. The setup
was an Apple M3 Pro, `-Xmx2g`, Postgres 18.4 in Docker Desktop, JDK
`28-ea+23-1886`, Hibernate 7.4.13.Final.

This measures a realistic workload, not a JMH microbenchmark. Most of the time
goes to JDBC and Hibernate's result processing, which is the point: that's
what your app actually spends.

| Run                       | Mapping          | Median load |   Allocated per load |
| ------------------------- | ---------------- | ----------: | -------------------: |
| Default, run 1            | value records    |   287.16 ms | 115.6 MB (606 B/row) |
|                           | identity records |   287.76 ms | 112.6 MB (590 B/row) |
| Default, run 2            | value records    |   272.11 ms | 115.6 MB (606 B/row) |
|                           | identity records |   259.95 ms | 112.6 MB (590 B/row) |
| `-XX:-UseFieldFlattening` | value records    |   200.26 ms | 112.6 MB (590 B/row) |
|                           | identity records |   202.71 ms | 112.6 MB (590 B/row) |

What I take from it:

- **Load time: no difference.** In each run the two mappings are within a few
  percent, and they swap order between runs. The gap between runs (the
  third run was faster for _both_ sides) is bigger than the gap between
  mappings.
- **Allocation: value records cost slightly more while loading.** It's exactly
  16 bytes more per row in both default runs, and the difference disappears when
  field flattening is turned off. Sixteen bytes is the size of one `Quantity`
  object. My reading is that Hibernate still builds a heap `Quantity` for each
  row, and the flattened field adds one more temporary copy on the way in or
  out. I haven't traced exactly where that copy happens, so take it as an
  explanation, not a finding.
- **The real win is retained memory, and it's small.** After the load,
  `ValueLine` keeps 16 fewer bytes per row alive (see the layout section above).
  If you keep a lot of entities in a persistence context, that's a modest heap
  saving. It isn't a throughput gain.

## What I couldn't measure

I also timed a pure in-memory loop, 200 passes over the 200,000 loaded entities
computing `price × quantity`, where you'd expect flattening to help most. The
results flipped between JVM runs. In one run value records took 100 ms against
487 ms for identity records. In the next they took 762 ms against 581 ms. That
loop is a JIT and memory-layout microbenchmark, and a Spring Boot test harness
can't measure it reliably. I'm not drawing any conclusion from it. The
[main Valhalla post](/posts/java-28-valhalla-value-classes-benchmark/) uses JMH
for that kind of question.

# Should you use value classes in your JPA model?

Once value classes are out of preview, a reasonable rule:

1. **Embeddables and typed IDs: yes, as `value record`s.** It's a one-word
   change, Hibernate already uses the canonical constructor, and you get true
   value semantics for free.
2. **Non-record value class embeddables: only with `@Instantiator`.** The
   classic no-arg constructor pattern fails at `persist`.
3. **Entities: no.** They need identity and mutability, and Hibernate needs
   to set their fields and subclass them for proxies.
4. **Don't expect your queries to get faster.** Database and driver costs
   dwarf the object layout. The benefit is a few bytes per loaded row, and
   only for small embeddables that the JVM actually flattens.
5. **Keep using `equals`.** `==` on a value object compares its fields by `==`,
   and `UUID` and `String` are still identity classes.

And for now: this is JDK 28 **early access** with a **preview** feature, so
don't ship it to production. Layouts, flattening rules and Hibernate's handling
can all change before JDK 28 GA (scheduled for March 2027) and in later
releases.

If you're tidying up your entity model in the meantime, the same "small,
strongly typed values" idea pays off today with
[UUIDv7 primary keys](/posts/uuidv7-in-spring-boot-and-postgres) and
[type-safe query building with the Specification API](/posts/spring-jpa-specification-api-2026).

# References

- [JEP 401: Value Classes and Objects (Preview)](https://openjdk.org/jeps/401)
- [JDK 28 early-access builds](https://jdk.java.net/28/)
- [Project Valhalla](https://openjdk.org/projects/valhalla/)
- [Hibernate ORM releases](https://hibernate.org/orm/releases/)
- [Sample code and raw results](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/valhalla-value-classes-jpa-hibernate)
