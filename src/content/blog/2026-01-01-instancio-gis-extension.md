---
author: StevenPG
pubDatetime: 2026-01-01T01:00:00.000Z
title: "Writing an Instancio Exception"
slug: writing-instancio-extension
featured: false
ogImage: /assets/default-og-image.png
tags:
  - java
description: Creating an Instancio Extension for Testing Java Applications
---

# Creating an Instancio Extension for Testing Java Applications

## A reliable way to auto-generate test data!

If you’ve been writing unit tests in Java for any significant amount of time, you are intimately familiar with the “test data setup” boilerplate. For example, you want to test a single validator, but first, you have to instantiate a complex nested object, populate mandatory fields, and ensure the state is valid just to reach the line of code you actually care about.

For a long time, we relied on the Builder pattern or manual setters. Then came Instancio.

If you haven’t used Instancio yet, it is a library that automates data creation. It uses reflection to populate your objects with random, yet sensible, data. It eliminates the noise from your tests.

This post assumes at least a little bit of working familiarily with Instancio, but if it is too vague, check out the getting started and user guide and come back!

The docs: https://www.instancio.org/getting-started/

## The Test Setup Tax

Here is what life looks like without Instancio. Let’s say we have a `Customer` object with an Address.

```java
@Test
void manualSetup() {

  // The “Old” Way
  Address address = new Address();
  address.setStreet(”123 Main St”);
  address.setCity(”New York”);
  address.setZip(”10001”);

  Customer customer = new Customer();
  customer.setId(UUID.randomUUID());
  customer.setName(”John Doe”);
  customer.setAddress(address);
  customer.setActive(true);

  // Finally, the test...
  service.process(customer);
}
```

This is tedious. It’s brittle. If the `Customer` constructor changes, you have to update every test.

Here is the same setup with Instancio:

```java
@Test
void instancioSetup() {
  // The Instancio Way
  Customer customer = Instancio.create(Customer.class);
  service.process(customer);
}
```

Instancio automatically populates primitives, Strings and nested objects that it has registered.

It’s also incredibly easy to do additional configuration on a created object, for example:

```java
Customer customer = Instancio.of(Customer.class)
    .set(field(Customer::getName), “Steve”)
    .create();
```

It helps that the documentation is very thorough and well laid out too!

## The Limitation: Third-Party Types

Instancio is magic when dealing with POJOs and standard Java types. However, it hits a wall when it encounters types it doesn’t understand—specifically, objects from third-party libraries or complex domain objects that require specific initialization logic.

By default, if Instancio sees a class it doesn’t know how to construct (like a Geometry from a Geospatial library, custom JSON object, or a specific Joda Time construct), it might leave it null or attempt to fill it with values that break internal validation rules.

By default, Instancio will leave these objects empty, leaving invisible gaps in test data.

You could handle this in every test, but there are a half dozen ways to configure a field when creating an object such as suppliers, Generators and field setters.

```java
Instancio.of(Location.class)
    .supply(field(Location::getPoint), () -> new Point(...))
    .create();
```

But what happens when you have many of these types, or work at a larger company where every team would need to create their own object instantiations for tests?

## The Enterprise Scenario: Shared Test Data

Imagine you have 10 different teams all working on microservices that consume the same “Shared Library” containing your core request/response objects.

If you are using a library like JTS (Java Topology Suite) for GeoSpatial data, you don’t want 50 developers across 10 teams writing the same generator function for a Polygon or Point in every single test class.

You want a unified way to generate data. You want to pull in a dependency, and have Instancio.create(MyComplexObject.class) just work.

This is where Instancio Extensions via the Java Service Provider Interface (SPI) come in.

## We accomplish this with the Instancio SPI Functionality

We can create a separate library—a “test-fixtures” artifact—that defines exactly how Instancio should generate these complex objects. When this library is added to your classpath (e.g., via Maven or Gradle), Instancio automatically detects it and uses your custom generators.

No configuration in the test class. It just loads.

### Project Layout

To make this work, we rely on the standard Java SPI mechanism. Here is the layout of the extension project:

```
my-instancio-extension/
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── org/
│   │   │       └── example/
│   │   │           └── InstancioServiceProviderImpl.java
│   │   └── resources/
│   │       └── META-INF/
│   │           └── services/
│   │               └── org.instancio.spi.InstancioServiceProvider
```

### The Implementation

There are four main pieces required.

#### 1. The Service Registration

In `src/main/resources/META-INF/services/org.instancio.spi.InstancioServiceProvider`, you simply add the fully qualified name of your implementation class:

`org.example.InstancioServiceProviderImpl`

#### 2. The Service Provider Implementation

This class implements `InstancioServiceProvider`. It tells Instancio: “Hey, when you see these classes, use these generators.”

```java
package org.example;
import org.instancio.spi.InstancioServiceProvider;
import org.instancio.spi.GeneratorProvider;

public class InstancioServiceProviderImpl implements InstancioServiceProvider {
  @Override
  public GeneratorProvider getGeneratorProvider() {
    // This is the map we use to do a type to generator mapping
    final Map<Class<?>, Generator<?>> generators = new HashMap<>();

    // This is how we register the given class with a generator
    generators.put(MyComplexClass.class, new MyComplexClassGenerator());

    return (Node node, Generators gen) -> generators.get(node.getTargetClass());
  }
}
```

#### 3. GeneratorSpec

The spec defines what methods are available to configure a given MyComplexClass. We’ll extend this in our generator, which will provide our generator with methods from extending GeneratorSpec<MyComplexClass>

public interface MyComplexTypeGeneratorSpec extends GeneratorSpec<MyComplexClass> {

    /**
     * Returns the current generator spec
     */
    MyComplexClassGeneratorSpec myCustomField(ComplexFieldObject fieldValue);
}

#### 4. Generator

```java
public class MyComplexClassGenerator implements MyComplexClassGeneratorSpec {

    private ComplexFieldObject myFieldObject = null;

    // This is where we control what happens when the configuration is called
    @Override
    MyComplexClassGeneratorSpec myCustomField(ComplexFieldObject fieldValue) {
        this.myFieldObject = fieldValue;
        return this;
    }

    @Override
    public MyComplexClass generate(Random random) {
        // We can always generate without having set myCustomField, so we simply check whether it's set
        if(this.myFieldObject == null) {
            // In this case, we return our object that Instancio couldn't understand on it's own
            return new ComplexFieldObject();
        } else {
            var object = new ComplexFieldObject();
            object.setMyCustomField(this.myFieldObject);
            return object;
        }
    }
}
```

To summarize:

- The service registration sets up a mapping between your complex type and which generator to use

- The ServiceProvider implementation automatically wires up the registration through the JVM


- The generatorspec acts as an interface into instancio for your generator

- The generator is actually called and creates objects based on the configurations provided.

### Real World Use Case: Third Party Geographical Libraries

I recently built an extension library to handle geospatial objects. You can find the library here. There are many types and tests to use as reference.

Working with Geometry in tests is notoriously annoying because valid geometries require specific coordinate structures (e.g., a Polygon ring must close).

![Geojson polygon](../../../public/assets/substack/geojson-io-polygon-example.png)

By wrapping this in an Instancio extension, I can generate valid random geometries effortlessly.

### Usage Examples

Once the library is added to your `pom.xml` or `build.gradle` as a `testImplementation` dependency, the usage is seamless.

1. Standard Generation

You don’t need to do anything special. Instancio detects the SPI implementation on the classpath.

```java
// Instancio now knows how to create valid CustomGeometry objects
// because the extension is on the classpath.
CustomGeometry = Instancio.create(CustomGeometry.class);
```

2. Customizing the Generator

If you built your generator to accept hints, you can still customize it within the test:

```java
// If your generator supports custom specs
Point p = Instancio.of(Point.class)
    .generate(field(Point::class), gen -> gen.spatial().coordinateSystem(”WGS84”))
    .create();
```

## Summary

Creating an Instancio extension is a high-leverage activity for senior developers or platform teams. By standardizing how complex, shared domain objects are generated, you reduce the friction of writing tests for the entire organization.

Simply creating a library that gets pulled into a project as a test artifact can enable a team to use Instancio and know they’re getting consistent and good random test data.

The magic of the Java SPI means your consumers don’t need to learn a new API—they just add the dependency, and `Instancio.create()` does the rest.