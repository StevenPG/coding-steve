---
layout: post
title:  "A FULL guide to converting Spring Boot 2 app to Spring Boot 3 Native Image"
toc: true
date:   2024-02-06 12:00:00 -0500
categories: 
  - software
  - spring boot
  - graalvm
  - native-image
---

# Migrating to Spring Boot 3 and Native Image

2024 comes with it a sense of finality when it comes to the end-of-life status of Spring Boot 2
and the embrace of Spring Boot 3 by the Spring community.

Tutorials are being updated, Spring Initialzr no longer supports any Spring Boot 2 versions and
dependencies are supporting Spring Boot 3 explicitly.

At my current job, I've spent a good deal of time converting Spring Boot 2 applications to Spring Boot
3, and with it a migration into utilizing Native Images using GraalVM. In my experience, the documentation
around this transition is spotty and disjoint. I can't find a singular place where the basic changes
needed to perform the upgrade are clearly listed out.

So I intend to create that place, with a simple blog post that walks through converting an application with
common pieces, all in one place.

## The Latest Tools

In support of upgrading, we should upgrade to the latest Java and Gradle versions. The same may apply to Maven but I'm
only including Gradle in this post.

For this post, we're going to be talking about the latest version of GraalVM so that we can take advantage of spring boot's
native image support.

If you're not familiar with GraalVM, it can be thought of as a different distribution of the Java Runtime Engine, and it can
execute Java applications the same as any JRE. However, it also supports native image creation, which will be addressed 
in this page and the results we can expect from going native-image. This post won't go into the benefits or tradeoffs with
native images, but focuses on creating them reliably.

#### Windows

GraalVM installation on windows can be done easily using the .msi file available on [Oracle's website](https://www.oracle.com/java/technologies/downloads/#jdk21-windows)

#### MacOS + Linux

Similar to installing normal Java installations, we can use [sdkman](https://sdkman.io/) to perform the install

#### Gradle Upgrade

Since we're focused on Gradle instead of Maven, we want to upgrade to the latest version of Gradle to try to guarantee
compatibility. 

## Upgrading a Spring Boot 2 Application

The assumptions in this post are that we're converting a Spring Boot application that uses
Spring Data JPA, Spring Web MVC, Spring Actuator and a few more smaller dependencies.

### Going Spring Boot 3

We can look at our `build.gradle` file and update the following components:

    plugins {
        id 'java'
        id 'org.springframework.boot' version '3.2.2'
        id 'io.spring.dependency-management' version '1.1.4'
    }
    
    java {
        sourceCompatibility = '21'
    }

That should be it! You may need to make updates to your IDE or environment to account
for JDK21, but otherwise reloading the gradle project will get the ball rolling!

### Gradle Plugin Updates

To support native compilation, we're going to need to add a gradle plugin. Use your existing configuration (single or
multi module) to add the following plugin:

`id 'org.graalvm.buildtools.native' version '0.9.28'`

Grab the latest version! This is the latest as of early 2024.

Next we have 2 sections to configure, one will be explained later.

The first is `bootBuildImage`. This may be different, but the instructions here will be
in Gradle - Groovy.

Add the following sections to your `build.gradle`

    bootJar {
        enabled = true
    }
    
    bootBuildImage {
        builder = "paketobuildpacks/builder-jammy-full:0.3.331"
        environment = [
            "BP_NATIVE_IMAGE": "true",
            "BP_JVM_VERSION": "21"
        ]
    }
    
    graalvmNative {
        testSupport = false
        metadataRepository {
        enabled = true
    }
    
        binaries {
            configureEach {
                resources.autodetect()
            }
        }
    }

The `bootJar` section is for enabling our runnable jar that'll be used for building the native image.

Second is the `bootBuildImage`. This is what we'll use to build runnable images that can be deployed.
We include the configuration for native images and Java 21, but you can change these to the values needed
for your project.

Lastly, the `graalvmNative` section is where we'll add in our support for AoT tests and the metadata repository.

The details around the metadata repository are included in the above Spring documentation, but suffice to say we'll want
to enable the metadata repository in our project to avoid as many native issues as possible.

These types of issues are explained in the documentation, with a deeper explanation available here:

https://www.graalvm.org/22.0/reference-manual/native-image/

### Javax to Jakarta

We're starting with an interesting change that occurred in 2020 around Jakarta EE. If you haven't
already run into this issue, many libraries post-2020 are using 
[Jakarta EE 9](https://jakarta.ee/blogs/javax-jakartaee-namespace-ecosystem-progress/), which changes the namespace
from `javax` to `jakarta`. So when you update to the next version of spring boot from the last step,
this may be the first build error you run into.

For example, `import javax.persistence cannot be resolved`

To resolve this issue, simply find-and-replace all `javax` imports and change them to `jakarta`, and that's it!

If you are using old libraries that depend on javax, you should be able to locate the javax api dependencies and 
add them into the project. For example, some older dependencies may require `javax.servlet-api`.

That dependency can be found here:

https://mvnrepository.com/artifact/javax.servlet/javax.servlet-api

### Spring Security

The sample Spring Security setup below is a common security configuration for
a Spring Web MVC application.

    @Component
    public class SecurityConfig extends WebSecurityConfigurerAdapter
    {
        @Override
        protected void configure(HttpSecurity http) throws Exception {
            http.authorizeRequests(authorizeRequests -> authorizeRequests
                    .mvcMatchers("/actuator/**").permitAll()
                    .mvcMatchers("/api/**").authenticated()
                    .anyRequest().denyAll()
        )
        .oauth2ResourceServer().jwt()
        .jwtAuthenticationConverter(converter());
    }

This configuration changes greatly for Spring Boot 3.

We transition from a `WebSecurityConfigurerAdapter` to a `SecurityFilterChain`. The reference
[doc for the new security component is available here](https://docs.spring.io/spring-security/reference/servlet/architecture.html#servlet-securityfilterchain)

    @EnableWebSecurity
    @Configuration
    public class SecurityConfig
    {
        @Bean
        public SecurityFilterChain webFilterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests( authorize -> authorize
            .requestMatchers("/actuator/**").permitAll()
            .requestMatchers("/v1/**").authenticated()
            .anyRequest().denyAll()
        )
        .oauth2ResourceServer(oauth2 ->
            oauth2.jwt(
                jwt -> jwt.jwtAuthenticationConverter(converter())
            )
        );
        return http.build();
    }

The tl;dr for this section, are the following three changes.

The first is the copy-paste structural change. The second, is updating mvcMatchers to
`requestMatchers`. The third is using the new format of passing a lambda into the method, see
the converter() above across the two different examples.

With that (and some nuanced changes that can be found in the official documentation); we've migrated
the spring security configuration.

At this point, we can take some time to review the documentation spring has made available
to try to understand what's happening when we're creating these native images.

Check out the documentation below. It doesn't attempt to go into detail like this guide does about individual changes,
but it's invaluable to understand the information they've provided to be able to update our application
to be a functional native image.

https://docs.spring.io/spring-boot/docs/current/reference/htmlsingle/#native-image

### GraalVM and Building for the Tracing Agent

### Running the Tracing Agent

### How to run our Native Image

- nativeCompile and nativeRun

### Building Docker Containers

- boot build image

## TODO
- spring native updates
- requirements for spring native
- running the tracing agent
- running in gradle or maven
- boot build image, with run command