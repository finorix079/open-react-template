require('dotenv').config();

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@grpc/grpc-js',
    '@langfuse/otel',
    '@langfuse/tracing',
    '@elasticdash/otel',
    '@elasticdash/tracing',
  ],
};

module.exports = nextConfig;
