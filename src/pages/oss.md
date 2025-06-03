---
layout: ../layouts/OSSLayout.astro
title: "OSS"
---

As part of my career in this field, I'm trying to give back to the open source community every
time I get a good opportunity. This page is intended to categorize and document my open source
contributions over the years, just as a summary and maybe as an example to anyone else who may
come across this and be similar to me.

# My Contributions

### Spring Cloud Streams Samples

I've committed two separate examples, the first was an example that was missing from the
documentation on setting up a batch producer for kafka, and the second were examples of
RecordRecoverableProcessor and DltAwareProcessor.
https://github.com/spring-cloud/spring-cloud-stream-samples/commit/547ca663c581c22c5fe212aba560552d3cada061

One of the issues that resulted in the samples being added 
was: https://github.com/spring-cloud/spring-cloud-stream-samples/issues/239

### Spring Cloud Streams

I'm a MASSIVE fan of Spring Cloud Streams, so I brought up the following issues to one of the
maintainers about a gap in the API: https://github.com/spring-cloud/spring-cloud-stream/issues/2776

From there, that resulted in the following issue being opened, where I chatted with the maintainer
about how to finalize the implementation: https://github.com/spring-cloud/spring-cloud-stream/issues/2779

The final implementation ended up being the RecordRecoverableProcessor and DltAwareProcessor objects available
for the kafka-streams binder. I added the samples for them to save the maintainer some
time: https://github.com/spring-cloud/spring-cloud-stream-samples/commit/13bc86a240fc5cda77f6a01075fe687a599e7fe7

Finally, I tacked on a little trace log: https://github.com/spring-cloud/spring-cloud-stream/issues/2802

And while I didn't write much of any of the code in the actual library, it feels good to have left a small mark
on a library I use a ton!

### Instancio

Instancio is an instantiation and testing library. I opened up an issue to add Spatial objects
https://github.com/instancio/instancio/issues/951 and the maintainer suggested I add them, so I did!

https://github.com/instancio/instancio/commit/58a6677b4eeb99d8b0f7c534868fc0f492d8db4a

They were accepted and are available to any users to generate spatial coordinates with!

# My Open Source Software

Nothing here just yet...
