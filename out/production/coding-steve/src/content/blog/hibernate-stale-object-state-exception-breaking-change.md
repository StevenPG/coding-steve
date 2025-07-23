---
author: StevenPG
pubDatetime: 2025-03-01T12:00:00.000Z
title: Hibernate 6.6 Breaking Changes - StaleObjectStateException
slug: hibernate-stale-object-state-exception-breaking-change
featured: true
ogImage: /assets/3af54ca0-32eb-4af8-8540-d43c6e9565f3.png
tags:
  - software
  - spring boot
  - java
description: Spring Boot's update to Hibernate 6.6 brings with it a breaking change that could silently cause issues in projects using it.
---

## Breaking Changes in Spring Boot Version 3.4.0 using Hibernate

This document outlines critical breaking changes introduced in version 6.6 of the Hibernate library for Spring Boot. 
Developers upgrading to this version must understand and address these changes to ensure application stability and 
prevent unexpected failures at runtime.

**Change Summary:**

Hibernate version 6.6 introduces a significant alteration to the way an Entity ID is handled through Hibernate and by extension, Spring Data JPA.
Previous versions allowed for inserting an id into an entity even when the id was marked `@GeneratedValue`. 
This approach has been replaced with a StaleObjectStateException for correctness. However, this means that
any projects that actively insert an id will fail at runtime after Spring Boot 3.4.0. For some, this can be an
insidious issue due to low areas of testing or optional insertion workflows.

The update is documented at the following jboss link: https://docs.jboss.org/hibernate/orm/6.6/migration-guide/migration-guide.html#merge-versioned-deleted

**Technical Details:**

A demo is available here: https://github.com/StevenPG/HibernateBreakingChangeDemo

**Compilation Errors:**

There are no compilation errors from this issue, the error will occur at runtime.

**Runtime Exceptions:**

Attempting to insert an id on a field marked with `@GeneratedValue` will trigger runtime exceptions:

An example exception from the linked test repository is below:

```
Row was updated or deleted by another transaction (or unsaved-value mapping was incorrect): [com.stevenpg.demo.ExampleEntity#1]
org.springframework.orm.ObjectOptimisticLockingFailureException: Row was updated or deleted by another transaction (or unsaved-value mapping was incorrect): [com.stevenpg.demo.ExampleEntity#1]
	at org.springframework.orm.jpa.vendor.HibernateJpaDialect.convertHibernateAccessException(HibernateJpaDialect.java:325)
	at org.springframework.orm.jpa.vendor.HibernateJpaDialect.translateExceptionIfPossible(HibernateJpaDialect.java:244)
	...
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
Caused by: org.hibernate.StaleObjectStateException: Row was updated or deleted by another transaction (or unsaved-value mapping was incorrect): [com.stevenpg.demo.ExampleEntity#1]
	at org.hibernate.event.internal.DefaultMergeEventListener.entityIsDetached(DefaultMergeEventListener.java:426)
	at org.hibernate.event.internal.DefaultMergeEventListener.merge(DefaultMergeEventListener.java:214)
	...
	at org.springframework.transaction.interceptor.TransactionInterceptor.invoke(TransactionInterceptor.java:119)
	at org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(ReflectiveMethodInvocation.java:184)
	at org.springframework.dao.support.PersistenceExceptionTranslationInterceptor.invoke(PersistenceExceptionTranslationInterceptor.java:138)
	... 9 more


Row was updated or deleted by another transaction (or unsaved-value mapping was incorrect): [com.stevenpg.demo.ExampleEntity#1]
org.hibernate.StaleObjectStateException: Row was updated or deleted by another transaction (or unsaved-value mapping was incorrect): [com.stevenpg.demo.ExampleEntity#1]
	at app//org.hibernate.event.internal.DefaultMergeEventListener.entityIsDetached(DefaultMergeEventListener.java:426)
	at app//org.hibernate.event.internal.DefaultMergeEventListener.merge(DefaultMergeEventListener.java:214)
	at app//org.hibernate.event.internal.DefaultMergeEventListener.doMerge(DefaultMergeEventListener.java:152)
	...
	at java.base@21.0.3/java.util.ArrayList.forEach(ArrayList.java:1596)
	at java.base@21.0.3/java.util.ArrayList.forEach(ArrayList.java:1596)
```

**Migration Procedures:**

This can be resolved by simply downgrading to an older version of Spring Boot, or by removing the `@GeneratedValue` annotation
from your entity. If the application intends to sometimes or always set the ID, simply allow the application to generate
the random identifier.

For example,

```java
myEntity.setId(UUID.randomUUID());
```

| Spring Boot Version | Hibernate Version | Will Error Occur |
|---------------------|-------------------|------------------|
| 3.3.9               | 6.5.3             | No               |
| 3.4.0               | 6.6.2             | Yes              |
| 3.4.3               | 6.6.2             | Yes              |

To ensure a successful upgrade, simply ensure the Hibernate version matches the table and expected error
result above. Versions later than 6.6.2 are expected to include the issue.

**Commentary**

In my own work, we have many API endpoints that allow the user to override the identifier. Rather than have
a separate identifier for the user and for the database, we instead simply insert the user's preferred UUID.

This is now a huge issue, as we have an optional flow in each controller that allows for an insertion on an
entity that contains `@GeneratedValue`.

We now have to do dedicated testing through our applications when upgrading past Spring Boot 3.4.0 to ensure these
issues do not occur at runtime in a production environment through this breaking change.

We have simply swapped `@GeneratedValue` for `UUID.randomUUID()` where necessary, while inserting the id supplied
by the user when requested.
