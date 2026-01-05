---
layout: ../layouts/OSSLayout.astro
title: "Open Source"
---

I am a passionate advocate for open-source software and believe in giving back to the community that enables so much of our industry's innovation. This page highlights my active participation in the ecosystem, ranging from maintaining my own libraries to contributing improvements and bug fixes to widely-used frameworks.

## My Projects

### [instancio-gis](https://github.com/stevenpg/instancio-gis)
**Core Maintainer**

An extension for the [Instancio](https://www.instancio.org/) library that enables automated generation of geospatial objects (JTS) for Java testing.

*   **Impact:** Simplifies the testing of GIS-enabled applications by removing the boilerplate required to create valid, complex geometries.
*   **Technologies:** Java, JTS (Java Topology Suite), Instancio SPI.
*   **Key Achievement:** Implemented a seamless integration using Java SPI, allowing users to generate random, valid Polygons, Points, and LineStrings with zero configuration.
*   **Blog Post:** [Writing an Instancio Extension Library](/posts/writing-instancio-extension/)

---

## Contributions

### Spring Cloud Stream

I am a frequent user and contributor to the Spring Cloud Stream ecosystem, focusing on improving the developer experience and expanding API capabilities.

*   **API Enhancement:** Identified and proposed a gap in the Kafka Streams binder API for recoverable processors. Collaborated with maintainers to refine the implementation of `RecordRecoverableProcessor` and `DltAwareProcessor`.
    *   [Issue #2776: Gap in API](https://github.com/spring-cloud/spring-cloud-stream/issues/2776)
    *   [Issue #2779: Implementation Discussion](https://github.com/spring-cloud/spring-cloud-stream/issues/2779)
*   **Documentation & Samples:** Contributed high-quality examples to the official samples repository to help other developers implement advanced patterns.
    *   [Kafka Batch Producer Sample](https://github.com/spring-cloud/spring-cloud-stream-samples/commit/547ca663c581c22c5fe212aba560552d3cada061)
    *   [Recoverable Processor Samples](https://github.com/spring-cloud/spring-cloud-stream-samples/commit/13bc86a240fc5cda77f6a01075fe687a599e7fe7)
*   **Observability:** Added targeted trace logging to assist in debugging complex stream processing issues.
    *   [Issue #2802: Trace Log Addition](https://github.com/spring-cloud/spring-cloud-stream/issues/2802)

### Instancio

Contributed to the core library to expand its built-in generation capabilities.

*   **Spatial Support:** Implemented native support for generating Spatial objects, reducing the need for custom generators in many common testing scenarios.
    *   [Issue #951: Add Spatial Support](https://github.com/instancio/instancio/issues/951)
    *   [Additional Spatial Contribution](https://github.com/instancio/instancio/commit/58a6677b4eeb99d8b0f7c534868fc0f492d8db4a)

---

> Leaving a small mark on the libraries I use every day is my way of supporting the tools that support my career.
