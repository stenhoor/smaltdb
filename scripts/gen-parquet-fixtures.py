"""Writes the Parquet test fixtures in test/fixtures/parquet with pyarrow (an independent writer).

    pip install pyarrow && python3 scripts/gen-parquet-fixtures.py
"""
import datetime as dt
import decimal
import os

import pyarrow as pa
import pyarrow.parquet as pq

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'parquet')
os.makedirs(OUT, exist_ok=True)

# Every common type, with NULLs.
types = pa.table({
    'i32': pa.array([1, -2, None], pa.int32()),
    'i64': pa.array([2**40, None, -(2**62)], pa.int64()),
    'u8': pa.array([255, 0, None], pa.uint8()),
    'f32': pa.array([1.5, None, -0.25], pa.float32()),
    'f64': pa.array([3.141592653589793, 2.5, None], pa.float64()),
    'b': pa.array([True, False, None]),
    's': pa.array(['héllo', None, ''], pa.string()),
    'bin': pa.array([b'\x00\x01', None, b'\xff'], pa.binary()),
    'd': pa.array([dt.date(2024, 2, 29), None, dt.date(1970, 1, 1)], pa.date32()),
    'ts': pa.array([dt.datetime(2024, 1, 2, 3, 4, 5, 678000), None, dt.datetime(1999, 12, 31, 23, 59, 59)], pa.timestamp('ms')),
    'tsu': pa.array([dt.datetime(2024, 1, 2, 3, 4, 5, 678901), None, None], pa.timestamp('us', tz='UTC')),
    'dec': pa.array([decimal.Decimal('12.34'), None, decimal.Decimal('-0.01')], pa.decimal128(9, 2)),
    'lst': pa.array([[1, 2], None, []], pa.list_(pa.int64())),
    'st': pa.array([{'x': 1, 'y': 'a'}, None, {'x': None, 'y': 'b'}], pa.struct([('x', pa.int32()), ('y', pa.string())])),
})
pq.write_table(types, os.path.join(OUT, 'types.parquet'))

# 4,000 rows in row groups of 500 (ascending id, so statistics separate them), several codecs.
n = 4_000
sales = pa.table({
    'id': pa.array(range(n), pa.int64()),
    'region': pa.array(['eu', 'us', 'apac', 'eu'] * (n // 4), pa.string()),  # dictionary-encoded
    'amount': pa.array([float(i % 97) for i in range(n)], pa.float64()),
    'day': pa.array([dt.date(2024, 1, 1) + dt.timedelta(days=i // 50) for i in range(n)], pa.date32()),
    'note': pa.array([('x' * 40) + str(i) for i in range(n)], pa.string()),  # a wide column projection should skip
})
for codec in ['snappy', 'gzip', 'zstd', 'none']:
    pq.write_table(sales, os.path.join(OUT, f'sales-{codec}.parquet'), row_group_size=500, compression=codec)

# A Hive-partitioned dataset.
for year in (2023, 2024):
    for month in (1, 2):
        d = os.path.join(OUT, 'events', f'year={year}', f'month={month:02d}')
        os.makedirs(d, exist_ok=True)
        pq.write_table(pa.table({'n': pa.array([year * 100 + month, year * 100 + month + 1], pa.int32())}), os.path.join(d, 'part-0.parquet'))
print('written', OUT)
