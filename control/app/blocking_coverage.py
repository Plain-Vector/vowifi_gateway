"""Count distinct numbers covered by fixed-length rules without expanding masks."""
import heapq


def calculate(records):
    events = {}
    count = {'block': 0, 'allow': 0}
    unbounded = False
    for idx, (number, kind, action, priority) in enumerate(records):
        count[action] += 1
        if kind == 'prefix':
            unbounded = True
            continue
        pattern = number.lstrip('+')
        low = int(pattern.replace('#', '0'))
        high = int(pattern.replace('#', '9'))
        events.setdefault(len(pattern), []).extend(((low, 1, idx, priority, action),
                                                    (high + 1, -1, idx, priority, action)))
    if unbounded:
        return {**count, 'blocked_numbers': None}
    blocked = 0
    for points in events.values():
        points.sort()
        previous = points[0][0]
        heap, active = [], set()
        for position, operation, idx, priority, action in points:
            while heap and heap[0][2] not in active:
                heapq.heappop(heap)
            if heap and heap[0][3] == 'block':
                blocked += position - previous
            if operation == 1:
                active.add(idx)
                heapq.heappush(heap, (priority, action != 'allow', idx, action))
            else:
                active.discard(idx)
            previous = position
    return {**count, 'blocked_numbers': blocked}
