---
author: StevenPG
pubDatetime: 2025-11-15T12:00:00.000Z
title: Why You Should Use Instancio for Unit Testing
slug: why-you-should-use-instancio-for-unit-testing
featured: true
draft: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - java
  - gradle
  - testing
description: Instancio is a super useful library that allows unit test writers to generate objects in a clean and reproducible manner.
---

# Instancio: Stop Hand-Building Test Objects in Java

## Brief

Building test objects by hand is tedious, error-prone, and scales terribly. Instancio is a library that generates fully populated Java objects for your unit tests with minimal configuration. This post is the simplest place on the internet to understand why you should be using it and how to get started.

## The Pain Points

Let's be honest—how do you currently build objects for unit tests?

**Option 1: The Manual Builder**

```java
User user = new User();
user.setId(1L);
user.setName("John Doe");
user.setEmail("john@example.com");
user.setAge(30);
user.setActive(true);
user.setCreatedAt(LocalDateTime.now());
user.setUpdatedAt(LocalDateTime.now());
user.setPhoneNumber("+1-555-0123");
user.setAddress("123 Main St");
// ... and 10 more fields
```

This is verbose and every time you add a field to User, tests break.

**Option 2: The Builder Pattern**

```java
User user = User.builder()
    .id(1L)
    .name("John Doe")
    .email("john@example.com")
    .age(30)
    .active(true)
    .createdAt(LocalDateTime.now())
    .updatedAt(LocalDateTime.now())
    .phoneNumber("+1-555-0123")
    .address("123 Main St")
    .build();
```

Better, but you're still specifying every field. Add a required field? Every test breaks. You're writing noise instead of testing behavior.

**Option 3: Test Fixtures**

```java
public static User createTestUser() {
    return User.builder()
        .id(1L)
        .name("John Doe")
        // ... 15 more lines
        .build();
}
```

Now you have factory methods scattered across your codebase. They become bottlenecks—change one, update dozens of tests.

## Why Instancio?

Instancio generates complete, valid objects automatically. You specify only what matters for your test.

```java
User user = Instancio.create(User.class);
```

That's it. Every field is populated with sensible defaults. Your test stays focused on behavior, not setup.

## The Setup

Add this to your build.gradle:

```gradle
dependencies {
    testImplementation 'org.instancio:instancio-junit:5.3.1'
}
```

## Examples

### Example 1: Create a Complete Object

```java
@Test
void userCanLogin() {
    User user = Instancio.create(User.class);
    
    assertTrue(user.isActive());
    assertNotNull(user.getId());
}
```

### Example 2: Customize Specific Fields

```java
@Test
void inactiveUserCannotLogin() {
    User user = Instancio.of(User.class)
        .set(field(User::isActive), false)
        .set(field(User::getEmail), "inactive@example.com")
        .create();
    
    assertFalse(loginService.canLogin(user));
}
```

### Example 3: Create Multiple Objects with Variations

```java
@Test
void orderTotalCalculatesCorrectly() {
    List<OrderItem> items = Instancio.ofList(OrderItem.class)
        .size(5)
        .create();
    
    Order order = Instancio.of(Order.class)
        .set(field(Order::getItems), items)
        .create();
    
    assertEquals(items.stream()
        .mapToDouble(OrderItem::getPrice)
        .sum(), order.calculateTotal(), 0.01);
}
```

### Example 4: Nested Objects

```java
@Test
void userWithAddressAndContactInfo() {
    User user = Instancio.create(User.class);
    
    // User, User.Address, User.ContactInfo all populated
    assertNotNull(user.getAddress().getStreet());
    assertNotNull(user.getContactInfo().getPhoneNumber());
}
```

### Example 5: Complex Collections

```java
@Test
void processMultipleOrders() {
    Map<Long, Order> orderMap = Instancio.ofMap(Long.class, 
        Order.class)
        .size(10)
        .create();
    
    assertEquals(10, orderMap.size());
    orderMap.values().forEach(order -> 
        assertNotNull(order.getId())
    );
}
```

## Why Instancio Over Alternatives

**vs. Builders:**
- Builders require you to set every field
- Instancio generates defaults automatically
- Add a new field? Builders break, Instancio doesn't

**vs. Test Fixtures:**
- Fixtures are centralized bottlenecks
- Instancio is decentralized and flexible
- Change behavior in one test without affecting others

**vs. Random Data:**
- `new Random().nextInt()` is unpredictable in failures
- Instancio provides consistent, reproducible test data
- Easy to see exactly what was generated

**vs. Mockito/Mocks:**
- Mocks hide real behavior
- Instancio creates real objects for integration testing
- You can mock specific fields while keeping others real

## Bonus: Combine Instancio with DataFaker

DataFaker generates realistic fake data (names, emails, addresses). Pair it with Instancio for control + realism.

```gradle
testImplementation 'net.datafaker:datafaker:2.1.0'
testImplementation 'org.instancio:instancio-junit:5.3.1'
```

```java
@Test
void sendEmailToRealLookingUser() {
    Faker faker = new Faker();
    
    User user = Instancio.of(User.class)
        .set(field(User::getName), faker.name().fullName())
        .set(field(User::getEmail), faker.internet().emailAddress())
        .set(field(User::getPhoneNumber), 
            faker.phoneNumber().cellPhone())
        .create();
    
    emailService.sendWelcomeEmail(user);
    
    assertTrue(emailCaptor.wasCalled());
}
```

Now your test data looks realistic (real name formats, valid email domains) while still being under your control.

## Bonus: Custom Generators

Sometimes you need custom logic for specific fields. Use `withSupplier()`:

```java
@Test
void userWithCustomId() {
    AtomicLong idCounter = new AtomicLong(1000);
    
    User user = Instancio.of(User.class)
        .supply(field(User::getId), () -> 
            idCounter.incrementAndGet())
        .create();
    
    assertTrue(user.getId() >= 1001);
}
```

For complex objects, create a custom generator:

```java
@Test
void userWithSpecificDomain() {
    Instancio.of(User.class)
        .generate(field(User::getEmail), gen -> 
            gen.string().prefix("test-")
                .suffix("@company.com"))
        .create();
}
```

This keeps your test setup clean while handling domain-specific requirements.

## Summary

Stop writing boilerplate test setup code. Instancio generates complete, valid objects automatically. Customize only what matters for your specific test. Combine it with DataFaker for realistic data. Your tests become focused on behavior, not object construction. That's the whole point.

---

*software   java   testing   unit-tests*
