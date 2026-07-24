# Product

## Register

product

## Users

Developers using Pi who want to run and supervise multiple agent sessions without leaving their terminal workflow. They need to create, enter, monitor, and resume isolated agents with minimal setup friction.

## Product Purpose

Pi Agent View provides a supervisor-backed view of multiple persistent Pi sessions. Success means a developer can start a safe worker quickly, interact with it as naturally as a normal Pi session, and retain clear control over isolation, lifecycle, and recovery.

## Brand Personality

Pi-native, focused, low-friction. The interface should feel trustworthy and direct rather than novel or administrative.

## Anti-references

Setup wizards, modal-heavy flows, configuration forms before basic use, dashboard abstractions that make an agent feel like a background job, and decorative terminal interfaces that obscure standard Pi behavior.

## Design Principles

1. Enter the task before configuring the tool.
2. Make each attached thread feel like its own Pi session.
3. Keep safety-critical choices explicit and default routine choices sensibly.
4. Preserve context, input, and worker state across navigation and failures.
5. Use familiar Pi interaction patterns instead of inventing parallel ones.

## Accessibility & Inclusion

Support complete keyboard operation, clear focus and state feedback, terminal-width-safe rendering, and WCAG AA-equivalent text contrast. Do not rely on color alone to communicate thread state.
