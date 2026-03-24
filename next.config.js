require('dotenv').config();

/** @type {import('next').NextConfig} */
const nextConfig = {                                                                                                                                                                                   
  experimental: {                                                                                                                                                                                          
    externalDir: true,   // allow imports from outside the project root                                                                                                                                    
  },
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@grpc/grpc-js',
    '@langfuse/otel',
    '@langfuse/tracing',
    'elasticdash-test',
  ],
};

module.exports = nextConfig;
