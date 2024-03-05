---
layout: post
title:  "Converting Spring Boot 2 to Spring Boot 3 Native Image w/ GraalVM"
toc: true
date:   2024-03-04 12:00:00 -0500
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

[GraalVM Native Image Documentation](https://www.graalvm.org/22.0/reference-manual/native-image/)

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

[Maven Central: javax.servlet/javax.servlet-api](https://mvnrepository.com/artifact/javax.servlet/javax.servlet-api)

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

Now for the most confusing but interesting part of this
whole GraalVM process.

It's mentioned in the documentation, but I hope here to summarize this complicated part of the native-image process.

When you do a nativeCompile (for example), the GraalVM
compilation process attempts to locate and mark down all
of the places in the code things that aren't supported
by native images are done. Things like reflection, dynamic property configuration, classloading, reading
files off of the filesystem dynamically, etc.

However, it's not perfect (far from it!), so we have to help out the process.

The documentation on the tracing agent is available here:
https://www.graalvm.org/latest/reference-manual/native-image/metadata/AutomaticMetadataCollection/

There's a set of files that contain each a very specific chunk of data
that together, informs the native-image what needs to be included in the compilation.

These files are generated and then placed in the src/main/resources/META-INF/native-image folder.

Trying to write these files by hand would be CRAZY difficult, so the tracing agent allows us to execute our application via the JVM, and the agent will write out the files for us.

The methodology will be explained in the how-to-run section coming up!

Until then, here are the files you can expect to generate (and sometimes manually update!)

These files are (with examples!):

1. jni-config.json

    Any JNI references the application needs to know about

        [{
            "name":"java.util.Arrays",
            "methods":[{"name":"asList","parameterTypes":["java.lang.Object[]"] }]
        }]

2. predefined-classes-config.json

    Bytecode references to existing, predefined classes. (I've never seen this populated across the dozen applications I've migrated to native-image!)

        [{
            "type": "agent-extracted",
            "classes": [
                {
                    "hash": "<class-bytecodes-hash>",
                    "nameInfo": "<class-name"
                }
            ]
        }]


3. proxy-config.json

    This file allows for pre-defining classes that will be generated at runtime. This isn't supported by native-image, so it'll need to be known in advance.

    There are a handful of spring classes that the tracing agent will provide here that are managed via proxy!

        [
            {
                "interfaces":["org.springframework.beans.factory.annotation.Qualifier"]
            },
            {
                "interfaces":["org.springframework.boot.actuate.endpoint.annotation.Endpoint"]
            },
            {
                "interfaces":["org.springframework.boot.actuate.endpoint.annotation.EndpointExtension"]
            },
            {
                "interfaces":["org.springframework.boot.context.properties.ConfigurationProperties"]
            },
            {
                "interfaces":["org.springframework.web.bind.annotation.ControllerAdvice"]
            },
            {
                "interfaces":["org.springframework.web.bind.annotation.RequestMapping"]
            }
        ]

4. reflect-config.json

    Reflection is not supported within native-images! All the classes dynamically managed via reflection need to be configured here to be found in the native-image



5. resource-config.json

    This file specifies all of the known files and resource bundles to roll into the native-image to be referenced directly.

    The tracing agent will add any file that must be included into the native-image, not just external resource bundles.

        "resources":{
            "includes":[{
                "pattern":"\\QMETA-INF/resources/index.html\\E"
            }, {
                "pattern":"\\QMETA-INF/services/ch.qos.logback.classic.spi.Configurator\\E"
            }, {
                "pattern":"\\QMETA-INF/services/jakarta.el.ExpressionFactory\\E"
            }, {
                "pattern":"\\QMETA-INF/services/jakarta.persistence.spi.PersistenceProvider\\E"
            }, {
                "pattern":"\\QMETA-INF/services/jakarta.validation.ConstraintValidator\\E"
            }]
        }

6. serialization-config.json

    Serialization generally utilizes reflection in some way to retrieve information for the serialization process. This file is where those additional pieces of information can be provided.

        {
            "types": [
                {
                "condition": {
                    "typeReachable": "<condition-class>"
                },
                "name": "<fully-qualified-class-name>",
                "customTargetConstructorClass": "<custom-target-constructor-class>"
                }
            ],
            "lambdaCapturingTypes": [
                {
                "condition": {
                    "typeReachable": "<condition-class>"
                },
                "name": "<fully-qualified-class-name>",
                "customTargetConstructorClass": "<custom-target-constructor-class>"
                }
            ]
        }


### Running the Tracing Agent

The tracing agent is an agent-lib we're going to attach to our jar execution. It's going to generate the files from the previous section.

The goal of the tracing agent, is to exercise the application. Each time a new reflection activity occurs, or a new file is loaded, the agent will populate the file.

We have two options, specifying the directory to write these files to, or merging to an existing directory.

The latter makes it easier to test your application holistically and with multiple passthroughs.

We'll first build the application using `./gradlew clean build`

The first option, is simply providing a folder to the agent:

    $JAVA_HOME/bin/java -agentlib:native-image-agent=config-merge-dir=/config -jar /build/libs/app.jar

The merge option is 

    $JAVA_HOME/bin/java -agentlib:native-image-agent=config-merge-dir=/config -jar /build/libs/app.jar

### How to run our Native Image

Now that we have our native-image metadata files that should help guarantee our application runs correctly, we can focus on the two initial ways to run out native-image.

The first, manually compiling our executable and running it by hand.

This is a simple process. First we run `./gradlew clean build nativeCompile`

From there, you'll find a file called `app` in the ./build/native folder structure.

You can run this simply using `./app`.

Our second option, is a one-step process. We simply execute `./gradlew clean build nativeRun`

This will nativeCompile and execute the application.

### Building Docker Containers

Our final (and most useful) native-image option is `bootBuildImage`.

This command will perform a native compilation and embed the executable in a Docker image.

This image can be run anywhere that supports Docker, making this command immensely powerful.

There are plenty of configurations available with building this image as well; different base images, pre-named images, hard coded values like JVM_VERSION, etc.

### Final Thoughts

This is far from an all inclusive guide on GraalVM native-images using Spring Boot 3, but I hope anyone who stumbles across this page gains some value from it.

I've filled this page will all of the things that slowed me down during my own journey to convert a handful of my company's applications into native-images.