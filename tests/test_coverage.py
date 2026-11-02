from app.blocking_coverage import calculate


def test_mask_overlap_priority_and_allow_exclusion():
    result = calculate([('+33162######','android','block',100),
                        ('+331621#####','android','block',200),
                        ('+33162123456','exact','allow',50),
                        ('+33162123457','exact','allow',500)])
    assert result == {'block':2,'allow':2,'blocked_numbers':999999}
