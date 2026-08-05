/**
 * lru.test.js — Unit tests for the doubly linked list (LRU tracking).
 *
 * These tests verify the pure data structure independent of the cache logic.
 * Each test validates both the operation's return value AND the structural
 * integrity of the list (sentinel pointers, length, ordering).
 */

import { describe, test, expect } from '@jest/globals';
import { Node, DoublyLinkedList } from '../src/lru.js';

describe('DoublyLinkedList', () => {
  // ─── Construction ──────────────────────────────────────────────────

  test('new list is empty with sentinels wired correctly', () => {
    const list = new DoublyLinkedList();

    expect(list.length).toBe(0);
    // Sentinels point to each other — no real nodes between them
    expect(list.head.next).toBe(list.tail);
    expect(list.tail.prev).toBe(list.head);
    // Sentinels have no key/value
    expect(list.head.key).toBeNull();
    expect(list.tail.key).toBeNull();
  });

  // ─── addToFront ────────────────────────────────────────────────────

  test('addToFront inserts a single node between sentinels', () => {
    const list = new DoublyLinkedList();
    const node = new Node('A', 'value-A');

    list.addToFront(node);

    expect(list.length).toBe(1);
    // HEAD ↔ A ↔ TAIL
    expect(list.head.next).toBe(node);
    expect(node.prev).toBe(list.head);
    expect(node.next).toBe(list.tail);
    expect(list.tail.prev).toBe(node);
  });

  test('addToFront inserts at the front (most recent position)', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');
    const c = new Node('C', '3');

    list.addToFront(a); // HEAD ↔ A ↔ TAIL
    list.addToFront(b); // HEAD ↔ B ↔ A ↔ TAIL
    list.addToFront(c); // HEAD ↔ C ↔ B ↔ A ↔ TAIL

    expect(list.length).toBe(3);

    // Verify order from head to tail
    expect(list.head.next).toBe(c);
    expect(c.next).toBe(b);
    expect(b.next).toBe(a);
    expect(a.next).toBe(list.tail);

    // Verify reverse pointers (doubly linked)
    expect(list.tail.prev).toBe(a);
    expect(a.prev).toBe(b);
    expect(b.prev).toBe(c);
    expect(c.prev).toBe(list.head);
  });

  // ─── remove ────────────────────────────────────────────────────────

  test('remove unlinks a middle node', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');
    const c = new Node('C', '3');

    list.addToFront(c);
    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ C ↔ TAIL

    list.remove(b); // HEAD ↔ A ↔ C ↔ TAIL

    expect(list.length).toBe(2);
    expect(a.next).toBe(c);
    expect(c.prev).toBe(a);
  });

  test('remove the only node leaves list empty', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');

    list.addToFront(a); // HEAD ↔ A ↔ TAIL
    list.remove(a);     // HEAD ↔ TAIL

    expect(list.length).toBe(0);
    expect(list.head.next).toBe(list.tail);
    expect(list.tail.prev).toBe(list.head);
  });

  test('remove the first real node', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');

    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ TAIL

    list.remove(a); // HEAD ↔ B ↔ TAIL

    expect(list.length).toBe(1);
    expect(list.head.next).toBe(b);
    expect(b.prev).toBe(list.head);
  });

  test('remove the last real node', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');

    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ TAIL

    list.remove(b); // HEAD ↔ A ↔ TAIL

    expect(list.length).toBe(1);
    expect(a.next).toBe(list.tail);
    expect(list.tail.prev).toBe(a);
  });

  // ─── moveToFront ──────────────────────────────────────────────────

  test('moveToFront promotes a node from the back', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');
    const c = new Node('C', '3');

    list.addToFront(c);
    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ C ↔ TAIL

    list.moveToFront(c); // HEAD ↔ C ↔ A ↔ B ↔ TAIL

    expect(list.length).toBe(3);
    expect(list.head.next).toBe(c);
    expect(c.next).toBe(a);
    expect(a.next).toBe(b);
    expect(b.next).toBe(list.tail);
  });

  test('moveToFront on the front node is a no-op (structurally)', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');

    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ TAIL

    list.moveToFront(a); // HEAD ↔ A ↔ B ↔ TAIL (no change)

    expect(list.length).toBe(2);
    expect(list.head.next).toBe(a);
    expect(a.next).toBe(b);
    expect(b.next).toBe(list.tail);
  });

  // ─── removeLast ────────────────────────────────────────────────────

  test('removeLast returns the LRU node (furthest from head)', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');
    const c = new Node('C', '3');

    list.addToFront(c);
    list.addToFront(b);
    list.addToFront(a); // HEAD ↔ A ↔ B ↔ C ↔ TAIL

    const evicted = list.removeLast();

    expect(evicted).toBe(c);
    expect(evicted.key).toBe('C');
    expect(list.length).toBe(2);
    expect(list.tail.prev).toBe(b);
  });

  test('removeLast on empty list returns null', () => {
    const list = new DoublyLinkedList();

    const result = list.removeLast();

    expect(result).toBeNull();
    expect(list.length).toBe(0);
  });

  test('removeLast drains the list to empty', () => {
    const list = new DoublyLinkedList();
    list.addToFront(new Node('A', '1'));
    list.addToFront(new Node('B', '2'));

    list.removeLast(); // removes A
    list.removeLast(); // removes B

    expect(list.length).toBe(0);
    expect(list.head.next).toBe(list.tail);
    expect(list.tail.prev).toBe(list.head);
  });

  // ─── peekFront / peekLast ─────────────────────────────────────────

  test('peekFront returns the MRU node without removing it', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');

    list.addToFront(b);
    list.addToFront(a);

    expect(list.peekFront()).toBe(a);
    expect(list.length).toBe(2); // Not removed
  });

  test('peekLast returns the LRU node without removing it', () => {
    const list = new DoublyLinkedList();
    const a = new Node('A', '1');
    const b = new Node('B', '2');

    list.addToFront(b);
    list.addToFront(a);

    expect(list.peekLast()).toBe(b);
    expect(list.length).toBe(2); // Not removed
  });

  test('peekFront and peekLast return null on empty list', () => {
    const list = new DoublyLinkedList();

    expect(list.peekFront()).toBeNull();
    expect(list.peekLast()).toBeNull();
  });
});
